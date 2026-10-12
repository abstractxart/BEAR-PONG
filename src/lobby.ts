/**
 * THE LOBBY - everything between "connected" and "playing".
 *
 *   presence      who is online, searching, playing (lobby_status, protocol 3)
 *   the queue     skill-matched: the closest rating first, the window widening
 *                 every second anyone waits - a quiet night still matches fast
 *   accept        protocol 3: a match must be ACCEPTED by both (a player can be
 *                 deep in a solo mode when it is found). Whoever declines or
 *                 lets it time out leaves the queue; whoever accepted goes
 *                 straight back to the FRONT of it.
 *   two games     CHAOS (the main one - the lab's black holes, multiball, orbs
 *                 and god tier, ChaosSession) and CLASSIC (GameSession). Each
 *                 has its own queue; a room is one or the other. Older clients
 *                 only know classic.
 *   rooms         private matches: a 5-letter code (and share link) - the host
 *                 waits, a friend joins, the match starts. Unrated (no ladder).
 *   rematch       after a private match both press REMATCH: the same two again,
 *                 sides swapped. (Not after ranked: guaranteed pairings would
 *                 let two friends trade wins up the ladder.)
 *   emotes        quick chat, ids only, rate-limited, relayed to both seats.
 *
 * No timers and no sockets library here: index.ts feeds it messages and calls
 * tick() twice a second, and the tests drive it with fake sockets and a clock.
 */
import type { WebSocket } from 'ws';
import { ChaosSession } from './ChaosSession.js';
import { GameSession } from './GameSession.js';
import { EMOTE_COUNT, GAME_CONFIG, SERVER_PROTOCOL, type GameMode, type PlayerData } from './types.js';

export interface Seat { ws: WebSocket; data: PlayerData }
/** a match of either game */
export type Match = GameSession | ChaosSession;
interface Queued extends Seat { since: number; mmr: number; mode: GameMode }
interface Room { code: string; host: Seat; winScore: number; created: number; mode: GameMode }

/** first to: a chaos match is longer and wilder per point */
export const DEFAULT_WIN: Record<GameMode, number> = { chaos: 5, classic: GAME_CONFIG.WINNING_SCORE };
interface ClientInfo { protocol: number; joins: number[]; lastEmote: number }

/** Room codes: no I, O, 0 or 1 - nothing to misread when a friend reads it out. */
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 5;
export const ROOM_TTL_MS = 20 * 60 * 1000;
/** the client counts down 15s; the server allows a little more for the wire */
export const ACCEPT_MS = 20_000;
export const REMATCH_MS = 60_000;
export const WIN_SCORES = [3, 5, 7];
/** how long after match_found the ready lobby opens (the old clients' timing) */
const LOBBY_DELAY_MS = 1000;
const JOIN_LIMIT = { windowMs: 60_000, max: 8 };
const EMOTE_GAP_MS = 1200;
const EMOTE_MAX = 40;
const DEFAULT_MMR = 500;

/** How far apart two ratings may be to meet once the longer of them has waited `ms`. */
export function mmrWindow(ms: number): number {
  return 120 + 60 * Math.max(0, ms) / 1000;
}

/** Normalise what a player typed or pasted as a room code. */
export function normaliseCode(raw: unknown): string {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);
}

/**
 * A client's self-description, cut down to what the server relays to a rival:
 * known fields only, bounded lengths, sane numbers. (The old server relayed
 * whatever arrived - any size, any field - to the opponent.)
 */
export function cleanPlayer(raw: unknown): PlayerData {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const wallet = str(o.wallet, 64) || `guest_${Math.random().toString(36).slice(2, 10)}`;
  const avatar = str(o.avatarUrl, 600);
  const rank = o.rank && typeof o.rank === 'object' ? (o.rank as Record<string, unknown>) : null;
  const mmr = Number(rank?.mmr);
  const games = Number(rank?.games);
  const protocol = Number(o.protocol);
  return {
    wallet,
    displayName: str(o.displayName, 40) || 'Player',
    avatarUrl: /^https?:\/\//i.test(avatar) ? avatar : undefined,
    avatarIsAnimated: o.avatarIsAnimated === true || undefined,
    protocol: Number.isFinite(protocol) ? Math.max(1, Math.min(9, Math.floor(protocol))) : 1,
    rank: rank && Number.isFinite(mmr) ? { mmr: Math.max(0, Math.min(4000, Math.round(mmr))), games: Number.isFinite(games) ? Math.max(0, Math.min(1e6, Math.floor(games))) : 0 } : undefined,
  };
}

export interface LobbyDeps {
  send(ws: WebSocket, msg: unknown): void;
  /** is this socket still open? */
  open(ws: WebSocket): boolean;
  now?: () => number;
  random?: () => number;
  /** schedule a callback (tests run it at once or on their own clock) */
  later?: (fn: () => void, ms: number) => void;
}

export class Lobby {
  readonly queue: Queued[] = [];
  readonly rooms = new Map<string, Room>();
  private roomOf = new Map<WebSocket, string>();
  private sessions = new Map<WebSocket, Match>();
  private clients = new Map<WebSocket, ClientInfo>();
  private rematches = new Map<Match, { want: Set<WebSocket>; until: number }>();
  private emotes = new WeakMap<Match, number>();
  private lastStatus = '';

  constructor(private readonly d: LobbyDeps) {}

  private now(): number { return this.d.now ? this.d.now() : Date.now(); }
  private rand(): number { return this.d.random ? this.d.random() : Math.random(); }
  private later(fn: () => void, ms: number): void { (this.d.later ?? ((f, t) => { setTimeout(f, t); }))(fn, ms); }
  private send(ws: WebSocket, msg: unknown): void { this.d.send(ws, msg); }

  private info(ws: WebSocket): ClientInfo {
    let c = this.clients.get(ws);
    if (!c) this.clients.set(ws, (c = { protocol: 1, joins: [], lastEmote: -Infinity }));
    return c;
  }

  // ------------------------------------------------------------ presence
  connect(ws: WebSocket): void { this.info(ws); }

  /** protocol 3 announces itself: it gets lobby_status from now on */
  hello(ws: WebSocket, protocol: unknown): void {
    const p = Number(protocol);
    this.info(ws).protocol = Number.isFinite(p) ? Math.max(1, Math.min(9, Math.floor(p))) : 1;
    this.send(ws, { type: 'welcome', serverVersion: SERVER_PROTOCOL, ...this.status() });
  }

  status(): { online: number; searching: number; playing: number; rooms: number; chaos: number; classic: number } {
    const live = new Set<Match>();
    this.sessions.forEach((s) => { if (!s.ended) live.add(s); });
    const chaos = this.queue.filter((q) => q.mode === 'chaos').length;
    return { online: this.clients.size, searching: this.queue.length, playing: live.size * 2, rooms: this.rooms.size, chaos, classic: this.queue.length - chaos };
  }

  private broadcastStatus(): void {
    const st = this.status();
    const key = JSON.stringify(st);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.clients.forEach((c, ws) => { if (c.protocol >= SERVER_PROTOCOL) this.send(ws, { type: 'lobby_status', ...st }); });
  }

  // ------------------------------------------------------------ sessions
  /** the match this socket is in (live, or just finished) */
  sessionOf(ws: WebSocket): Match | undefined {
    return this.sessions.get(ws);
  }

  private liveSession(ws: WebSocket): Match | undefined {
    const s = this.sessions.get(ws);
    return s && !s.ended ? s : undefined;
  }

  /** A finished match keeps its players attached (for emotes and a rematch) until they move on. */
  private detach(ws: WebSocket): void {
    const s = this.sessions.get(ws);
    if (!s || !s.ended) return;
    this.sessions.delete(ws);
    this.rematches.delete(s);
    // the rival on the results screen learns at once: no rematch with someone who left
    if (s.completed && s.options.private) {
      for (const p of s.getPlayers()) if (p !== ws && this.sessions.get(p) === s) this.send(p, { type: 'rematch_unavailable' });
    }
  }

  private startMatch(a: Seat, b: Seat, opts: { winScore: number; private: boolean; room?: string; rematch?: boolean; mode: GameMode }): Match {
    this.detach(a.ws);
    this.detach(b.ws);
    const sessionOptions = {
      winScore: opts.winScore,
      private: opts.private,
      room: opts.room,
      acceptMs: ACCEPT_MS,
      onUnaccepted: (accepted: WebSocket[], missing: WebSocket[]) => this.unaccepted(session, accepted, missing),
    };
    const session: Match = opts.mode === 'chaos' ? new ChaosSession(a, b, sessionOptions) : new GameSession(a, b, sessionOptions);
    this.sessions.set(a.ws, session);
    this.sessions.set(b.ws, session);
    const extra = { serverVersion: SERVER_PROTOCOL, mode: opts.mode, winScore: session.winScore, private: opts.private, room: opts.room ?? null, rematch: !!opts.rematch };
    this.send(a.ws, { type: 'match_found', opponent: b.data, yourSide: 'left', ...extra });
    this.send(b.ws, { type: 'match_found', opponent: a.data, yourSide: 'right', ...extra });
    console.log(`🎮 ${opts.mode.toUpperCase()} ${opts.private ? `room ${opts.room}${opts.rematch ? ' rematch' : ''}` : 'match'}: ${a.data.displayName} vs ${b.data.displayName} (first to ${session.winScore})`);
    this.later(() => session.startBettingLobby(), LOBBY_DELAY_MS);
    this.broadcastStatus();
    return session;
  }

  /** Protocol 3: the accept window closed without both accepting. */
  private unaccepted(session: Match, accepted: WebSocket[], missing: WebSocket[]): void {
    for (const ws of missing) {
      if (this.sessions.get(ws) === session) this.sessions.delete(ws);
      this.send(ws, { type: 'match_declined', you: true, requeued: false });
    }
    for (const ws of accepted) {
      if (this.sessions.get(ws) === session) this.sessions.delete(ws);
      this.backToFront(ws, session);
    }
    this.broadcastStatus();
  }

  /** The rival turned it down: a ranked player goes straight back to the front of the queue. */
  private backToFront(ws: WebSocket, session: Match): void {
    const seat = session.seats().find((s) => s.ws === ws);
    if (!seat || !this.d.open(ws)) return;
    if ((seat.data.protocol ?? 1) < SERVER_PROTOCOL) {
      // an older client knows only the old cancellation (and requeues itself)
      this.send(ws, { type: 'betting_timeout' });
      return;
    }
    if (session.options.private) {
      this.send(ws, { type: 'match_declined', you: false, requeued: false });
      return;
    }
    // a minute of credit: first in line, and a wide skill window
    this.queue.unshift({ ...seat, since: this.now() - 60_000, mmr: seat.data.rank?.mmr ?? DEFAULT_MMR, mode: session.mode });
    this.send(ws, { type: 'match_declined', you: false, requeued: true });
    this.send(ws, { type: 'queue_joined', position: 1 });
  }

  // ------------------------------------------------------------ the queue
  joinQueue(ws: WebSocket, data: PlayerData, mode: GameMode = 'classic'): void {
    // chaos needs a protocol 3 client (accept, the lab's snapshots)
    if ((data.protocol ?? 1) < SERVER_PROTOCOL) mode = 'classic';
    const queued = this.queue.find((p) => p.ws === ws);
    if (queued) {
      if (queued.mode === mode) return;
      this.queue.splice(this.queue.indexOf(queued), 1); // switching games: same socket, the other queue
    }
    this.detach(ws);
    if (this.liveSession(ws)) {
      this.send(ws, { type: 'error', message: 'Already in a match' });
      return;
    }
    this.leaveRoom(ws);
    this.queue.push({ ws, data, since: this.now(), mmr: data.rank?.mmr ?? DEFAULT_MMR, mode });
    this.send(ws, { type: 'queue_joined', position: this.queue.length });
    this.pair();
    this.broadcastStatus();
  }

  leaveQueue(ws: WebSocket): void {
    const i = this.queue.findIndex((p) => p.ws === ws);
    if (i >= 0) this.queue.splice(i, 1);
    this.broadcastStatus();
  }

  /**
   * Pair the queue: the longest waiter first, with the closest rating inside
   * the window that their wait has earned. Never a wallet against itself (two
   * tabs of one account must not meet - it would farm the ladder).
   */
  private pair(): void {
    for (;;) {
      const t = this.now();
      const order = [...this.queue].sort((a, b) => a.since - b.since);
      let made = false;
      for (const a of order) {
        const win = mmrWindow(t - a.since);
        let best: Queued | null = null;
        for (const b of order) {
          if (b === a || b.mode !== a.mode) continue;
          if (a.data.wallet === b.data.wallet && !a.data.wallet.startsWith('guest_')) continue;
          const gap = Math.abs(a.mmr - b.mmr);
          if (gap > Math.max(win, mmrWindow(t - b.since))) continue;
          if (!best || gap < Math.abs(a.mmr - best.mmr)) best = b;
        }
        if (best) {
          this.queue.splice(this.queue.indexOf(a), 1);
          this.queue.splice(this.queue.indexOf(best), 1);
          this.startMatch(a, best, { winScore: DEFAULT_WIN[a.mode], private: false, mode: a.mode });
          made = true;
          break;
        }
      }
      if (!made) return;
    }
  }

  /** Accept (the old READY): the match starts once both have. */
  accept(ws: WebSocket): void {
    this.liveSession(ws)?.handleReadyToStart(ws);
  }

  /** Protocol 3: turn the match down. You leave the queue; your rival goes back to the front. */
  decline(ws: WebSocket): void {
    const s = this.liveSession(ws);
    if (!s) return;
    const other = s.decline(ws);
    if (!other) return;
    this.sessions.delete(ws);
    if (this.sessions.get(other) === s) this.sessions.delete(other);
    this.send(ws, { type: 'match_declined', you: true, requeued: false });
    this.backToFront(other, s);
    this.broadcastStatus();
  }

  // ------------------------------------------------------------ rooms
  private newCode(): string {
    for (let tries = 0; tries < 50; tries++) {
      let c = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) c += ROOM_ALPHABET[Math.floor(this.rand() * ROOM_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
    throw new Error('room codes exhausted');
  }

  createRoom(ws: WebSocket, data: PlayerData, winScore: unknown, rawMode: GameMode = 'chaos'): void {
    this.detach(ws);
    if (this.liveSession(ws)) {
      this.send(ws, { type: 'room_error', reason: 'busy' });
      return;
    }
    this.leaveQueue(ws);
    this.leaveRoom(ws);
    const ws_ = Number(winScore);
    const mode: GameMode = (data.protocol ?? 1) >= SERVER_PROTOCOL ? rawMode : 'classic';
    const room: Room = { code: this.newCode(), host: { ws, data }, winScore: WIN_SCORES.includes(ws_) ? ws_ : DEFAULT_WIN[mode], created: this.now(), mode };
    this.rooms.set(room.code, room);
    this.roomOf.set(ws, room.code);
    this.send(ws, { type: 'room_created', code: room.code, winScore: room.winScore, mode });
    this.broadcastStatus();
  }

  joinRoom(ws: WebSocket, rawCode: unknown, data: PlayerData): void {
    const c = this.info(ws);
    const t = this.now();
    c.joins = c.joins.filter((at) => t - at < JOIN_LIMIT.windowMs);
    if (c.joins.length >= JOIN_LIMIT.max) {
      this.send(ws, { type: 'room_error', reason: 'rate_limited' });
      return;
    }
    c.joins.push(t);
    const code = normaliseCode(rawCode);
    const room = this.rooms.get(code);
    if (!room || !this.d.open(room.host.ws)) {
      if (room) this.closeRoom(code);
      this.send(ws, { type: 'room_error', reason: 'not_found', code });
      return;
    }
    if (room.host.ws === ws) {
      this.send(ws, { type: 'room_error', reason: 'self', code });
      return;
    }
    this.detach(ws);
    if (this.liveSession(ws)) {
      this.send(ws, { type: 'room_error', reason: 'busy', code });
      return;
    }
    this.leaveQueue(ws);
    this.leaveRoom(ws);
    if (room.mode === 'chaos' && (data.protocol ?? 1) < SERVER_PROTOCOL) {
      this.send(ws, { type: 'room_error', reason: 'update', code });
      return;
    }
    this.closeRoom(code);
    this.startMatch(room.host, { ws, data }, { winScore: room.winScore, private: true, room: code, mode: room.mode });
  }

  private closeRoom(code: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    this.rooms.delete(code);
    if (this.roomOf.get(room.host.ws) === code) this.roomOf.delete(room.host.ws);
  }

  leaveRoom(ws: WebSocket): void {
    const code = this.roomOf.get(ws);
    if (code) this.closeRoom(code);
    this.broadcastStatus();
  }

  // ------------------------------------------------------------ rematch
  rematch(ws: WebSocket): void {
    const s = this.sessions.get(ws);
    const other = s?.getPlayers().find((p) => p !== ws);
    if (!s || !s.completed || !s.options.private || !other || this.sessions.get(other) !== s || !this.d.open(other)) {
      this.send(ws, { type: 'rematch_unavailable' });
      return;
    }
    let offer = this.rematches.get(s);
    if (!offer) this.rematches.set(s, (offer = { want: new Set(), until: this.now() + REMATCH_MS }));
    offer.want.add(ws);
    if (offer.want.size < 2) {
      this.send(other, { type: 'rematch_requested' });
      return;
    }
    this.rematches.delete(s);
    const [left, right] = s.seats();
    this.sessions.delete(left.ws);
    this.sessions.delete(right.ws);
    // sides swap: nobody keeps the better end of the court
    this.startMatch(right, left, { winScore: s.winScore, private: true, room: s.options.room, rematch: true, mode: s.mode });
  }

  // ------------------------------------------------------------ emotes
  emote(ws: WebSocket, id: unknown): void {
    const s = this.sessions.get(ws);
    const n = Number(id);
    if (!s || !Number.isInteger(n) || n < 0 || n >= EMOTE_COUNT) return;
    const side = s.sideOf(ws);
    const c = this.info(ws);
    const t = this.now();
    const count = this.emotes.get(s) ?? 0;
    if (!side || t - c.lastEmote < EMOTE_GAP_MS || count >= EMOTE_MAX) return;
    c.lastEmote = t;
    this.emotes.set(s, count + 1);
    for (const p of s.getPlayers()) if (this.sessions.get(p) === s) this.send(p, { type: 'emote', side, id: n });
  }

  // ------------------------------------------------------------ leaving
  /**
   * `graceful`: the player sent `leave` (their socket stays open for the
   * lobby); otherwise the socket closed. Either way they leave the queue,
   * their room and their match - a live match tells the rival, who has won.
   */
  disconnect(ws: WebSocket, graceful = false): void {
    const i = this.queue.findIndex((p) => p.ws === ws);
    if (i >= 0) this.queue.splice(i, 1);
    this.leaveRoom(ws);
    const s = this.sessions.get(ws);
    if (s) {
      // gone before the match even started: the rival goes back to the front of the queue
      const other = s.ended ? null : s.decline(ws);
      if (other) {
        this.sessions.delete(ws);
        if (this.sessions.get(other) === s) this.sessions.delete(other);
        this.backToFront(other, s);
      } else if (!s.ended) {
        s.handleDisconnect(ws, graceful);
        s.cleanup();
        s.getPlayers().forEach((p) => { if (this.sessions.get(p) === s) this.sessions.delete(p); });
      } else {
        this.detach(ws);
      }
    }
    if (!graceful) this.clients.delete(ws);
    this.broadcastStatus();
  }

  // ------------------------------------------------------------ the clock
  /** Twice a second: pair the queue, expire rooms and rematch offers, publish the counts. */
  tick(): void {
    const t = this.now();
    for (const [code, room] of this.rooms) {
      if (t - room.created > ROOM_TTL_MS || !this.d.open(room.host.ws)) {
        this.closeRoom(code);
        if (this.d.open(room.host.ws)) this.send(room.host.ws, { type: 'room_closed', reason: 'expired' });
      }
    }
    for (const [s, offer] of this.rematches) {
      if (t < offer.until) continue;
      this.rematches.delete(s);
      for (const p of s.getPlayers()) if (this.sessions.get(p) === s) this.send(p, { type: 'rematch_unavailable' });
    }
    this.pair();
    this.broadcastStatus();
  }
}

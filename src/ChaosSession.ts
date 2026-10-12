/**
 * CHAOS - the main online game: the Chaos Lab's own simulation (src/chaos,
 * mirrored from the client) run here, authoritative, between two players.
 * Black holes, multiball, power orbs, BEAR CURVE, god tier, the golden ball -
 * everything the lab has, now against a real person.
 *
 * It speaks exactly what the client's in-page lab speaks (LocalClient): the
 * sim's own events (countdown, chaos, ultimate_activated, game_over, ...) and
 * a game_state snapshot every tick. So the client draws an online chaos match
 * with the same code that draws the lab.
 *
 * LAG GRACE: a ball that reaches a face the defender's paddle is not at yet
 * waits there for up to their round trip (+45ms) before it is a miss - the
 * paddle the player saw arrive is on its way over the network. (The same rule
 * as the classic GameSession.)
 *
 * Only protocol 3 clients play chaos, so the match must be ACCEPTED by both
 * within `acceptMs` (the lobby requeues whoever did).
 */
import type { WebSocket } from 'ws';
import { CHAOS_RULES, PongSim, type SimEvent } from './chaos/PongSim.js';
import type { SessionOptions } from './GameSession.js';
import type { PlayerData } from './types.js';

type Seat = { ws: WebSocket; data: PlayerData };
const TICK_MS = 1000 / 60;
/** grace = round trip + this, clamped (the classic server's numbers) */
const GRACE = { jitter: 45, min: 60, max: 260, fallback: 120 };

export class ChaosSession {
  readonly mode = 'chaos' as const;
  readonly winScore: number;
  readonly options: SessionOptions;
  ended = false;
  completed = false;
  private started = false;
  private ready = new Set<WebSocket>();
  private sim: PongSim;
  private loop: ReturnType<typeof setInterval> | null = null;
  private pingLoop: ReturnType<typeof setInterval> | null = null;
  private lobbyTimer: ReturnType<typeof setTimeout> | null = null;
  private rtt = new Map<WebSocket, number>();
  private last = 0;
  private acc = 0;

  constructor(private readonly player1: Seat, private readonly player2: Seat, options: SessionOptions = {}) {
    this.options = options;
    this.winScore = Math.max(1, Math.min(11, Math.floor(options.winScore ?? 5)));
    this.sim = new PongSim({ ...CHAOS_RULES, winScore: this.winScore }, Math.floor(Math.random() * 2 ** 31));
  }

  get bothV3(): boolean { return true; }

  // ------------------------------------------------------------ the seats
  getPlayers(): WebSocket[] { return [this.player1.ws, this.player2.ws]; }
  seats(): Seat[] { return [this.player1, this.player2]; }
  sideOf(ws: WebSocket): 'left' | 'right' | null {
    return ws === this.player1.ws ? 'left' : ws === this.player2.ws ? 'right' : null;
  }
  private other(ws: WebSocket): WebSocket { return ws === this.player1.ws ? this.player2.ws : this.player1.ws; }

  // ------------------------------------------------------------ accept
  /** Both must accept within the window (the lobby decides who is requeued). */
  startBettingLobby(): void {
    if (this.started || this.ended || this.lobbyTimer) return;
    this.lobbyTimer = setTimeout(() => {
      this.lobbyTimer = null;
      if (this.started || this.ended) return;
      this.ended = true;
      this.stopLoops();
      const accepted = this.getPlayers().filter((p) => this.ready.has(p));
      const missing = this.getPlayers().filter((p) => !this.ready.has(p));
      this.options.onUnaccepted?.(accepted, missing);
    }, this.options.acceptMs ?? 20_000);
  }

  handleReadyToStart(ws: WebSocket): void {
    if (!this.sideOf(ws) || this.started || this.ended) return;
    this.ready.add(ws);
    this.send(this.other(ws), { type: 'opponent_ready' });
    if (this.ready.size === 2) this.start();
  }

  decline(ws: WebSocket): WebSocket | null {
    if (this.started || this.ended || !this.sideOf(ws)) return null;
    this.ended = true;
    this.stopLoops();
    return this.other(ws);
  }

  handleSetBet(_ws: WebSocket, _amount: number): void { /* betting is retired */ }

  // ------------------------------------------------------------ the match
  private start(): void {
    if (this.started || this.ended) return;
    this.started = true;
    if (this.lobbyTimer) { clearTimeout(this.lobbyTimer); this.lobbyTimer = null; }
    this.sim.start();
    this.last = Date.now();
    this.loop = setInterval(() => this.tick(), TICK_MS);
    const ping = () => {
      const t = Date.now();
      for (const p of this.getPlayers()) this.send(p, { type: 'ping', t });
    };
    ping();
    this.pingLoop = setInterval(ping, 1000);
  }

  /** a fixed 60Hz step, catching up after a late timer (never more than 4 at once) */
  private tick(): void {
    if (this.ended) return;
    const now = Date.now();
    this.acc += Math.min(250, now - this.last);
    this.last = now;
    let n = 0;
    while (this.acc >= TICK_MS && n < 4) {
      this.acc -= TICK_MS;
      n++;
      this.sim.graceTicks = { left: this.graceTicks(this.player1.ws), right: this.graceTicks(this.player2.ws) };
      this.sim.step();
      for (const e of this.sim.drain()) this.relay(e);
      if (this.ended) return;
    }
    if (n === 4) this.acc = 0;
    if (n) this.broadcast({ type: 'game_state', state: this.sim.snapshot() });
  }

  private relay(e: SimEvent): void {
    if (e.type === 'error') return; // an ability refused: told to its user in handleUseUltimate
    this.broadcast(e);
    if (e.type === 'game_over') {
      this.ended = true;
      this.completed = true;
      this.stopLoops();
      this.broadcast({ type: 'game_state', state: this.sim.snapshot() });
    }
  }

  private graceTicks(ws: WebSocket): number {
    const rtt = this.rtt.get(ws);
    const ms = rtt === undefined ? GRACE.fallback : Math.max(GRACE.min, Math.min(GRACE.max, rtt + GRACE.jitter));
    return Math.ceil(ms / TICK_MS);
  }

  updatePaddlePosition(ws: WebSocket, y: number, _timestamp?: number): void {
    const side = this.sideOf(ws);
    if (!side || !Number.isFinite(y) || this.ended) return;
    this.sim.setPaddle(side, y);
  }

  handlePong(ws: WebSocket, t: number): void {
    const sent = Number(t);
    if (!Number.isFinite(sent)) return;
    const rtt = Date.now() - sent;
    if (rtt < 0 || rtt > 5000) return;
    const prev = this.rtt.get(ws);
    // smoothed, so one slow packet does not swing the grace window
    this.rtt.set(ws, prev === undefined ? rtt : prev * 0.7 + rtt * 0.3);
  }

  handleUseUltimate(ws: WebSocket, abilityType: string): void {
    const side = this.sideOf(ws);
    if (!side || !this.started || this.ended || this.sim.phase !== 'live') return;
    if (!['time_freeze', 'power_hit', 'paddle_dash'].includes(abilityType)) return;
    if (!this.sim.useUltimate(side, abilityType)) {
      this.send(ws, { type: 'error', message: 'Ultimate already used!' });
    }
  }

  // ------------------------------------------------------------ leaving
  /** Mid-match, a leave or a drop tells the rival (who has won); after the whistle, nobody. */
  handleDisconnect(ws: WebSocket, graceful = false): void {
    const midMatch = this.started && !this.ended;
    const wasEnded = this.ended;
    this.ended = true;
    this.stopLoops();
    if (!wasEnded && (!graceful || midMatch)) this.send(this.other(ws), { type: 'opponent_disconnected' });
  }

  cleanup(): void { this.stopLoops(); }

  private stopLoops(): void {
    if (this.loop) clearInterval(this.loop);
    if (this.pingLoop) clearInterval(this.pingLoop);
    if (this.lobbyTimer) clearTimeout(this.lobbyTimer);
    this.loop = this.pingLoop = null;
    this.lobbyTimer = null;
  }

  // ------------------------------------------------------------ the wire
  private send(ws: WebSocket, msg: unknown): void {
    try {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    } catch (error) {
      console.error('Error sending message to player:', error);
    }
  }

  private broadcast(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const p of this.getPlayers()) {
      try { if (p.readyState === p.OPEN) p.send(data); } catch { /* the close handler deals with it */ }
    }
  }
}

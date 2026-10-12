// The lobby: queue, accept/decline, rooms, rematch, emotes, presence.
// Usage: npm test   (builds, then runs this against dist/)
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

// a controllable clock and timers (GameSession's ready lobby uses real timers)
let clock = 5_000_000;
Date.now = () => clock;
let timers = [];
let nextId = 1;
globalThis.setTimeout = (fn, ms = 0) => { const id = nextId++; timers.push({ id, at: clock + ms, fn }); return id; };
globalThis.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
globalThis.setInterval = (fn, ms) => { const id = nextId++; const t = { id, at: clock + ms, fn, every: ms }; timers.push(t); return id; };
globalThis.clearInterval = globalThis.clearTimeout;
function advance(ms) {
  const end = clock + ms;
  for (;;) {
    const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    clock = due.at;
    if (due.every) due.at += due.every; else timers = timers.filter((t) => t !== due);
    due.fn();
  }
  clock = end;
}

const dist = process.argv[2] ?? fileURLToPath(new URL("../dist", import.meta.url));
const { Lobby, cleanPlayer, mmrWindow, normaliseCode, ROOM_ALPHABET, ROOM_CODE_LENGTH, ROOM_TTL_MS } = await import(pathToFileURL(dist + "/lobby.js").href);

let names = 0;
function sock() { return { OPEN: 1, readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, name: `ws${++names}` }; }
const of = (ws, type) => ws.sent.filter((m) => m.type === type);
const last = (ws, type) => of(ws, type).at(-1);
function world() {
  const lobby = new Lobby({
    send: (ws, m) => ws.send(JSON.stringify(m)),
    open: (ws) => ws.readyState === 1,
    now: () => clock,
    random: Math.random,
  });
  return lobby;
}
const player = (name, extra = {}) => cleanPlayer({ wallet: `r${name}`, displayName: name, protocol: 3, rank: { mmr: 500, games: 10 }, ...extra });
function joined(lobby, name, extra) {
  const ws = sock();
  lobby.connect(ws);
  lobby.joinQueue(ws, player(name, extra));
  return ws;
}

let passed = 0;
function test(name, fn) {
  timers = [];
  try { fn(); passed++; console.log("  ok  ", name); }
  catch (e) { console.log("  FAIL", name, "\n", e.stack); process.exitCode = 1; }
}

test("two players of similar rating meet at once, protocol 3, first to 3, unrated", () => {
  const L = world();
  const a = joined(L, "A"), b = joined(L, "B", { rank: { mmr: 560, games: 9 } });
  const ma = last(a, "match_found"), mb = last(b, "match_found");
  assert.ok(ma && mb);
  assert.equal(ma.yourSide, "left");
  assert.equal(mb.yourSide, "right");
  assert.equal(ma.serverVersion, 3);
  assert.equal(ma.winScore, 3);
  assert.equal(ma.private, false);
  assert.equal(ma.opponent.displayName, "B");
  assert.equal(L.queue.length, 0);
});

test("far-apart ratings wait for the window to widen, then meet", () => {
  const L = world();
  const a = joined(L, "A", { rank: { mmr: 500, games: 30 } });
  const b = joined(L, "B", { rank: { mmr: 1500, games: 30 } });
  assert.equal(of(a, "match_found").length, 0, "1000 apart: not at once");
  assert.ok(mmrWindow(10_000) < 1000);
  advance(10_000); L.tick();
  assert.equal(of(a, "match_found").length, 0, "still too far after 10s");
  advance(8_000); L.tick();
  assert.equal(of(a, "match_found").length, 1, "met once the window covered the gap");
  assert.equal(of(b, "match_found").length, 1);
});

test("the closest rating is chosen for the longest waiter", () => {
  const L = world();
  const mk = (name, mmr, since) => { const ws = sock(); L.connect(ws); L.queue.push({ ws, data: player(name, { rank: { mmr, games: 30 } }), since, mmr, mode: "classic" }); return ws; };
  const a = mk("A", 500, clock - 5_000); // waited 5s: a window of 420
  const far = mk("FAR", 800, clock);
  const near = mk("NEAR", 540, clock);
  L.tick();
  assert.equal(last(a, "match_found").opponent.displayName, "NEAR");
  assert.equal(of(far, "match_found").length, 0, "FAR keeps waiting");
});

test("one wallet never meets itself (two tabs) - guests may", () => {
  const L = world();
  const a = joined(L, "A", { wallet: "rSAME" });
  const b = joined(L, "A2", { wallet: "rSAME" });
  advance(120_000); L.tick();
  assert.equal(of(a, "match_found").length + of(b, "match_found").length, 0);
  const g1 = joined(L, "G1", { wallet: "guest_1" });
  assert.equal(of(g1, "match_found").length, 1, "a guest meets the waiting player");
});

test("both accept -> the countdown starts", () => {
  const L = world();
  const a = joined(L, "A"), b = joined(L, "B");
  advance(1000); // the ready lobby opens
  L.accept(a);
  assert.equal(of(b, "opponent_ready").length, 1);
  L.accept(b);
  advance(1100);
  assert.ok(of(a, "countdown").length >= 1, "countdown running");
});

test("a decline: the decliner leaves, the rival goes straight back to the FRONT of the queue", () => {
  const L = world();
  const a = joined(L, "A"), b = joined(L, "B");
  advance(1000);
  L.accept(a);
  L.decline(b);
  assert.deepEqual({ ...last(b, "match_declined"), type: undefined }, { type: undefined, you: true, requeued: false });
  assert.equal(last(a, "match_declined").requeued, true);
  assert.equal(L.queue[0]?.ws, a, "A is first in line");
  const c = joined(L, "C");
  assert.equal(last(c, "match_found").opponent.displayName, "A", "the next arrival meets A");
});

test("the accept window: whoever did not accept in time is out; whoever did is requeued", () => {
  const L = world();
  const a = joined(L, "A"), b = joined(L, "B");
  advance(1000);
  L.accept(a);
  advance(20_000);
  assert.equal(last(b, "match_declined").you, true);
  assert.equal(last(a, "match_declined").requeued, true);
  assert.ok(L.queue.some((q) => q.ws === a));
  assert.ok(!L.queue.some((q) => q.ws === b));
});

test("an older client's rival who declines sends it the old cancellation it understands", () => {
  const L = world();
  const old = joined(L, "OLD", { protocol: 2 });
  const v3 = joined(L, "NEW");
  advance(1000);
  L.decline(v3);
  assert.equal(of(old, "betting_timeout").length, 1);
  assert.equal(of(old, "match_declined").length, 0);
});

test("leaving before the match starts puts the rival back at the front", () => {
  const L = world();
  const a = joined(L, "A"), b = joined(L, "B");
  b.readyState = 3;
  L.disconnect(b);
  assert.equal(last(a, "match_declined").requeued, true);
  assert.equal(L.queue[0].ws, a);
});

test("a private room: create, share the code, a friend joins (any case, any spacing) - unrated, their win score", () => {
  const L = world();
  const host = sock(); L.connect(host);
  L.createRoom(host, player("HOST"), 5);
  const made = last(host, "room_created");
  assert.equal(made.code.length, ROOM_CODE_LENGTH);
  assert.ok([...made.code].every((c) => ROOM_ALPHABET.includes(c)));
  assert.equal(made.winScore, 5);
  const friend = sock(); L.connect(friend);
  L.joinRoom(friend, ` ${made.code.slice(0, 2).toLowerCase()}-${made.code.slice(2)} `, player("FRIEND"));
  const mh = last(host, "match_found"), mf = last(friend, "match_found");
  assert.equal(mh.private, true);
  assert.equal(mh.room, made.code);
  assert.equal(mh.winScore, 5);
  assert.equal(mf.opponent.displayName, "HOST");
  assert.equal(L.rooms.size, 0, "the room is used up");
  assert.equal(L.sessionOf(host).winScore, 5);
});

test("room errors: no such room, your own room, and too many guesses", () => {
  const L = world();
  const host = sock(); L.connect(host);
  L.createRoom(host, player("HOST"), 3);
  L.joinRoom(host, last(host, "room_created").code, player("HOST"));
  assert.equal(last(host, "room_error").reason, "self");
  const guesser = sock(); L.connect(guesser);
  for (let i = 0; i < 8; i++) L.joinRoom(guesser, "ZZZZZ", player("G"));
  assert.equal(last(guesser, "room_error").reason, "not_found");
  L.joinRoom(guesser, last(host, "room_created").code, player("G"));
  assert.equal(last(guesser, "room_error").reason, "rate_limited", "brute-forcing codes is cut off");
  assert.equal(of(guesser, "match_found").length, 0);
});

test("a room expires, and a host who queues or leaves closes it", () => {
  const L = world();
  const host = sock(); L.connect(host);
  L.createRoom(host, player("HOST"), 3);
  advance(ROOM_TTL_MS + 1000); L.tick();
  assert.equal(last(host, "room_closed").reason, "expired");
  L.createRoom(host, player("HOST"), 3);
  L.joinQueue(host, player("HOST"));
  assert.equal(L.rooms.size, 0, "queueing closed the room");
});

function finishedPrivate(L) {
  const host = sock(); L.connect(host);
  L.createRoom(host, player("HOST"), 3);
  const friend = sock(); L.connect(friend);
  L.joinRoom(friend, last(host, "room_created").code, player("FRIEND"));
  const s = L.sessionOf(host);
  s.ended = true; s.completed = true; // played to the end
  return { host, friend, s };
}

test("rematch after a private match: both ask, the same two play again with sides swapped", () => {
  const L = world();
  const { host, friend } = finishedPrivate(L);
  L.rematch(host);
  assert.equal(of(friend, "rematch_requested").length, 1);
  L.rematch(friend);
  const m = last(host, "match_found");
  assert.equal(m.rematch, true);
  assert.equal(m.yourSide, "right", "sides swapped");
  assert.equal(last(friend, "match_found").yourSide, "left");
  assert.equal(m.private, true);
});

test("no rematch after ranked (no guaranteed pairings on the ladder), or once the rival has left", () => {
  const L = world();
  const a = joined(L, "A"), b = joined(L, "B");
  const s = L.sessionOf(a);
  s.ended = true; s.completed = true;
  L.rematch(a);
  assert.equal(of(a, "rematch_unavailable").length, 1);
  const p = finishedPrivate(L);
  L.joinQueue(p.friend, player("FRIEND")); // moved on
  assert.equal(of(p.host, "rematch_unavailable").length, 1, "told at once that the rival left");
  L.rematch(p.host);
  assert.equal(of(p.host, "rematch_unavailable").length, 2);
});

test("emotes: relayed to both with the sender's side; rate-limited; unknown ids dropped", () => {
  const L = world();
  const a = joined(L, "A"), b = joined(L, "B");
  L.emote(a, 2);
  assert.deepEqual(last(b, "emote"), { type: "emote", side: "left", id: 2 });
  assert.equal(of(a, "emote").length, 1, "the sender sees it too");
  L.emote(a, 3);
  assert.equal(of(b, "emote").length, 1, "too soon");
  advance(1300);
  L.emote(a, 99);
  L.emote(a, "x");
  assert.equal(of(b, "emote").length, 1, "bad ids ignored");
  L.emote(b, 0);
  assert.equal(last(a, "emote").side, "right");
});

test("presence: hello gets the counts; changes reach protocol 3 clients only", () => {
  const L = world();
  const old = sock(); L.connect(old);
  const watcher = sock(); L.connect(watcher); L.hello(watcher, 3);
  const w = last(watcher, "welcome");
  assert.equal(w.serverVersion, 3);
  assert.equal(w.online, 2);
  joined(L, "A");
  assert.equal(last(watcher, "lobby_status").searching, 1);
  joined(L, "B");
  assert.equal(last(watcher, "lobby_status").playing, 2);
  assert.equal(of(old, "lobby_status").length, 0);
});

test("a player's card is cleaned before a rival sees it", () => {
  const p = cleanPlayer({ wallet: "r1", displayName: "x".repeat(500), avatarUrl: "javascript:alert(1)", protocol: 3, rank: { mmr: 1e9, games: -4 }, junk: "y".repeat(10000) });
  assert.equal(p.displayName.length, 40);
  assert.equal(p.avatarUrl, undefined);
  assert.equal(p.rank.mmr, 4000);
  assert.equal(p.rank.games, 0);
  assert.equal("junk" in p, false);
  assert.equal(normaliseCode(" ab-cd 9 "), "ABCD9");
});

test("CHAOS and CLASSIC have separate queues: players only meet their own game", () => {
  const L = world();
  const a = sock(); L.connect(a); L.joinQueue(a, player("A"), "chaos");
  const b = sock(); L.connect(b); L.joinQueue(b, player("B"), "classic");
  advance(60_000); L.tick();
  assert.equal(of(a, "match_found").length + of(b, "match_found").length, 0, "never across games");
  const c = sock(); L.connect(c); L.joinQueue(c, player("C"), "chaos");
  const m = last(a, "match_found");
  assert.equal(m.opponent.displayName, "C");
  assert.equal(m.mode, "chaos");
  assert.equal(m.winScore, 5, "chaos is first to 5");
  assert.equal(L.sessionOf(a).mode, "chaos");
});

test("an older client asking for chaos gets classic (it cannot draw the lab)", () => {
  const L = world();
  const old = sock(); L.connect(old); L.joinQueue(old, player("OLD", { protocol: 2 }), "chaos");
  const c = sock(); L.connect(c); L.joinQueue(c, player("C2"), "classic");
  assert.equal(last(old, "match_found").mode, "classic");
});

test("switching game in the queue moves you, it does not duplicate you", () => {
  const L = world();
  const a = sock(); L.connect(a);
  L.joinQueue(a, player("A"), "classic");
  L.joinQueue(a, player("A"), "chaos");
  assert.equal(L.queue.length, 1);
  assert.equal(L.queue[0].mode, "chaos");
});

test("a chaos room is chaos; an older client cannot join it", () => {
  const L = world();
  const host = sock(); L.connect(host);
  L.createRoom(host, player("HOST"), 3, "chaos");
  const code = last(host, "room_created").code;
  assert.equal(last(host, "room_created").mode, "chaos");
  const old = sock(); L.connect(old);
  L.joinRoom(old, code, player("OLD", { protocol: 2 }));
  assert.equal(last(old, "room_error").reason, "update");
  const friend = sock(); L.connect(friend);
  L.joinRoom(friend, code, player("F"));
  assert.equal(last(friend, "match_found").mode, "chaos");
});

test("a CHAOS match: both accept, the lab's snapshots stream, abilities are once a point, it ends", () => {
  const L = world();
  const a = sock(); L.connect(a); L.joinQueue(a, player("A"), "chaos");
  const b = sock(); L.connect(b); L.joinQueue(b, player("B"), "chaos");
  const s = L.sessionOf(a);
  advance(1000);
  L.accept(a); L.accept(b);
  advance(4000); // the countdown, then play
  assert.ok(of(a, "countdown").length >= 3, "the sim's own countdown");
  const st = last(a, "game_state").state;
  assert.ok(Array.isArray(st.balls) && st.balls.length >= 1, "lab snapshots: balls[]");
  assert.equal(st.heightsAuthoritative, true);
  s.handleUseUltimate(a, "power_hit");
  s.handleUseUltimate(a, "power_hit");
  advance(40); // events go out with the next tick
  assert.ok(of(a, "ultimate_activated").length >= 1);
  assert.equal(last(a, "error").message, "Ultimate already used!");
  assert.equal(of(b, "error").length, 0);
  for (let i = 0; i < 400 && !s.ended; i++) advance(1000);
  assert.ok(s.ended && s.completed, "played to the end");
  const over = last(a, "game_over");
  assert.ok(over && Math.max(over.finalScore.left, over.finalScore.right) === 5);
  assert.deepEqual(last(b, "game_over").finalScore, over.finalScore);
});

test("chaos sets each side's lag grace from their measured round trip", () => {
  const L = world();
  const a = sock(); L.connect(a); L.joinQueue(a, player("A"), "chaos");
  const b = sock(); L.connect(b); L.joinQueue(b, player("B"), "chaos");
  const s = L.sessionOf(a);
  advance(1000); L.accept(a); L.accept(b);
  advance(200);
  s.handlePong(a, clock - 100); // a pong for a ping sent 100ms ago
  advance(50);
  assert.equal(s.sim.graceTicks.left, Math.ceil((100 + 45) / (1000 / 60)));
  assert.equal(s.sim.graceTicks.right, Math.ceil(120 / (1000 / 60)), "no answer yet: the fallback");
});

console.log(`\n${passed} passed`);

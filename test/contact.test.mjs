// Deterministic tests for the server's contact model (exact-hits-and-curve).
// Usage: npm test   (builds, then runs this against dist/)
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const dist = process.argv[2] ?? fileURLToPath(new URL("../dist", import.meta.url));
const { GameSession } = await import(pathToFileURL(dist + "/GameSession.js").href);
const { GAME_CONFIG } = await import(pathToFileURL(dist + "/types.js").href);

const R = GAME_CONFIG.BALL_SIZE / 2;
const LEFT_FACE = 50 + GAME_CONFIG.PADDLE_WIDTH + R;
let clock = 1_000_000;
const realNow = Date.now;
Date.now = () => clock;

function fakeWs() {
  return { OPEN: 1, readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); } };
}
function session() {
  const a = fakeWs(), b = fakeWs();
  const s = new GameSession({ ws: a, data: { wallet: "a", displayName: "A", protocol: 2 } }, { ws: b, data: { wallet: "b", displayName: "B", protocol: 2 } });
  s.started = true;
  s.gameState.gameStarted = true;
  return { s, a, b };
}
const tick = (s, n = 1) => { for (let i = 0; i < n; i++) { clock += 1000 / 60; s.updatePhysics(); } };
const aim = (s, { x, y, vx, vy = 0 }) => Object.assign(s.gameState, { ballX: x, ballY: y, ballVelocityX: vx, ballVelocityY: vy });
const hits = (ws) => ws.sent.filter((m) => m.type === "paddle_hit");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ok  ", name); }
  catch (e) { console.log("  FAIL", name, "\n", e.message); process.exitCode = 1; }
}

test("contact is EXACT: the ball stops on the face where it crosses - no early teleport", () => {
  const { s, a } = session();
  s.updatePaddlePosition(a, 360, clock);
  aim(s, { x: 200, y: 360, vx: -12 });
  // still 120px out: nothing happens yet (the old server snapped it here)
  tick(s, 5);
  assert.equal(hits(a).length, 0, "no hit before the ball reaches the face");
  assert.ok(s.gameState.ballX > LEFT_FACE);
  tick(s, 6);
  assert.equal(hits(a).length, 1);
  assert.equal(s.gameState.ballX, LEFT_FACE);
  assert.ok(s.gameState.ballVelocityX > 0, "reflected");
});

test("a hit holds the ball on the face (hit-stop), then releases it", () => {
  const { s, a } = session();
  s.updatePaddlePosition(a, 360, clock);
  aim(s, { x: LEFT_FACE + 10, y: 360, vx: -12 });
  tick(s);
  assert.equal(hits(a).length, 1);
  s.broadcastGameState();
  assert.equal(a.sent.at(-1).state.hold, true);
  tick(s);
  assert.equal(s.gameState.ballX, LEFT_FACE, "still on the face during the hit-stop");
  tick(s, 4);
  assert.ok(s.gameState.ballX > LEFT_FACE + 10, "released and away");
});

test("GRACE: a paddle that arrives a round trip late still makes the save", () => {
  const { s, a } = session();
  s.rtt[1] = 100; // grace = 145ms
  s.updatePaddlePosition(a, 200, clock); // 160px off: not there (yet)
  aim(s, { x: LEFT_FACE + 10, y: 360, vx: -12 });
  tick(s);
  assert.equal(hits(a).length, 0);
  assert.equal(s.gameState.ballX, LEFT_FACE, "waits on the face");
  tick(s, 4); // ~67ms later the paddle the player had when they SAW it arrives
  s.updatePaddlePosition(a, 350, clock);
  tick(s);
  assert.equal(hits(a).length, 1);
  const h = hits(a)[0];
  assert.ok(h.late > 50 && h.late < 145, `late by ${h.late}ms`);
  assert.ok(Math.abs(h.hitPosition - (360 - 350) / 60) < 1e-9, "hit position from the paddle that made the save");
  assert.equal(s.gameState.score2, 0);
});

test("a paddle that never gets there: the ball goes through after the grace window", () => {
  const { s, a } = session();
  s.rtt[1] = 100;
  s.updatePaddlePosition(a, 200, clock);
  aim(s, { x: LEFT_FACE + 10, y: 360, vx: -12 });
  tick(s, 12); // 200ms > 145ms grace
  assert.equal(hits(a).length, 0);
  tick(s, 12);
  assert.equal(s.gameState.score2, 1);
});

test("a paddle too far away to possibly reach: no waiting at all", () => {
  const { s, a } = session();
  s.rtt[1] = 100;
  s.updatePaddlePosition(a, 660, clock); // crossing at 60: 600px away
  aim(s, { x: LEFT_FACE + 10, y: 60, vx: -12 });
  tick(s);
  assert.equal(s.contact, null, "let straight through");
  tick(s, 1);
  assert.ok(s.gameState.ballX < LEFT_FACE);
});

test("a too-late paddle (after the window) does not count", () => {
  const { s, a } = session();
  s.rtt[1] = 60; // grace 105ms
  s.updatePaddlePosition(a, 200, clock);
  aim(s, { x: LEFT_FACE + 10, y: 360, vx: -12 });
  tick(s, 8); // 133ms: past the window
  s.updatePaddlePosition(a, 360, clock);
  tick(s, 10);
  assert.equal(hits(a).length, 0);
  assert.equal(s.gameState.score2, 1);
});

test("BEAR CURVE: a hard swing through contact puts spin on the ball, the way it was swung", () => {
  const { s, a } = session();
  // swinging DOWN at ~25px/tick over the last 50ms
  s.updatePaddlePosition(a, 300, clock - 50);
  s.samples[1][0].ct = clock - 50;
  s.updatePaddlePosition(a, 375, clock);
  aim(s, { x: LEFT_FACE + 10, y: 360, vx: -12 });
  tick(s);
  const h = hits(a)[0];
  assert.ok(h.spin > 0, `spin ${h.spin}`);
  // ...and a still paddle puts none
  const t = session();
  t.s.updatePaddlePosition(t.a, 360, clock - 400);
  t.s.updatePaddlePosition(t.a, 360, clock);
  aim(t.s, { x: LEFT_FACE + 10, y: 360, vx: -12 });
  tick(t.s);
  assert.equal(hits(t.a)[0].spin, 0);
});

test("the speed and angle rules are the original ones (PERFECT = two speed-ups)", () => {
  const { s, a } = session();
  s.updatePaddlePosition(a, 360, clock);
  aim(s, { x: LEFT_FACE + 10, y: 360, vx: -12 });
  tick(s);
  const h = hits(a)[0];
  assert.equal(h.perfect, true);
  assert.ok(Math.abs(Math.abs(s.gameState.ballVelocityX) - 12 * 1.035 * 1.035) < 1e-6);
});

test("start() can never run twice (the old double game loop)", () => {
  const { s } = session();
  s.started = false;
  s.gameState.gameStarted = false;
  s.start();
  const first = s.countdownInterval;
  s.start();
  assert.equal(s.countdownInterval, first);
  s.cleanup();
});

test("leaving MID-MATCH tells the rival; leaving after the match does not", () => {
  const { s, a, b } = session();
  s.handleDisconnect(a, true);
  assert.ok(b.sent.some((m) => m.type === "opponent_disconnected"));
  const t = session();
  t.s.ended = true;
  t.s.handleDisconnect(t.a, true);
  assert.ok(!t.b.sent.some((m) => m.type === "opponent_disconnected"));
});

test("abilities only work while the ball is in play", () => {
  const { s, a } = session();
  s.isPaused = true;
  s.handleUseUltimate(a, "time_freeze");
  assert.ok(!a.sent.some((m) => m.type === "ultimate_activated"));
  s.isPaused = false;
  s.handleUseUltimate(a, "time_freeze");
  assert.ok(a.sent.some((m) => m.type === "ultimate_activated"));
});

Date.now = realNow;
console.log(`\n${passed} passed`);

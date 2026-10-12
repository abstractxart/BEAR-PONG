// MIRRORED from BEAR-PONG/src/sim/PongSim.ts by scripts/sync-sim.mjs - do not edit here.
import { FIELD, type Side } from "./field.js";
import { applyCurve, BULLSEYE, CHAOS_CURVE, englishFor, spinFromSwing, wallBounce, type CurveRules } from "./curve.js";

/**
 * PongSim - a deterministic, fixed-tick (60Hz) pong simulation.
 *
 * CLASSIC_RULES mirror the live server (abstractxart/BEAR-PONG,
 * GameSession.ts) closely enough to drive the demo: +3.5% speed per return,
 * cap 27, perfect (|hit| <= .15) returns speed up twice, edge returns
 * (|hit| >= .7) get 1.8x angle, power hit = three more speed-ups, time
 * freeze = 3.33% speed for 1.3s, paddle dash = teleport to the ball.
 *
 * CHAOS_RULES are Professor BEAR's lab, where the client owns the physics
 * and can go as far as it likes: BEAR CURVE, multiball, power orbs, portals,
 * black holes that collapse into a SUPERNOVA, gravity storms, pinball
 * bumpers, tesla gates, mirror paddles, fireballs, magnet catches, ghost
 * balls, hit-stop, bullet time and SUDDEN DEATH.
 *
 * GOD TIER: late in a match, deep in a rally (or one time in four), every
 * experiment and the big orbs come in their ascended form - binary black
 * holes that spiral in and MERGE, a wormhole, a prism that splits the ball
 * into a rainbow, gravity that flips, an orrery of orbiting bumpers, a
 * rotating tesla cage, plasma, and the QUANTUM ball. And the shot that wins
 * the match plays out in FINAL BALL slow motion.
 *
 * No DOM, no Phaser, no timers - `step()` advances exactly one tick, and all
 * randomness comes from a seeded generator, so everything here is testable.
 */

export type OrbType = "split" | "mega" | "shrink" | "fire" | "warp" | "hole" | "magnet" | "ghost" | "mirror" | "quantum";
export type ExperimentName =
  | "BLACK HOLE" | "PORTALS" | "MULTIBALL" | "HYPERDRIVE" | "GRAVITY STORM" | "PINBALL" | "TESLA GATE"
  | "BINARY BLACK HOLES" | "WORMHOLE" | "PRISM" | "LIGHTSPEED" | "GRAVITY FLIP" | "ORRERY" | "TESLA CAGE";

/** Each experiment's ascended form. */
export const GOD_FORM: Record<string, ExperimentName> = {
  "BLACK HOLE": "BINARY BLACK HOLES",
  PORTALS: "WORMHOLE",
  MULTIBALL: "PRISM",
  HYPERDRIVE: "LIGHTSPEED",
  "GRAVITY STORM": "GRAVITY FLIP",
  PINBALL: "ORRERY",
  "TESLA GATE": "TESLA CAGE",
};

export interface Rules {
  name: "classic" | "chaos";
  winScore: number;
  serveSpeed: number;
  maxSpeed: number;
  speedUp: number;
  maxVy: number;
  curve: CurveRules | null;
  orbs: boolean;
  experiments: boolean;
  hitstop: boolean;
  /** every return holds the ball on the face this many ticks (the v2 server's 34ms) */
  contactStop: number;
  /** THE SQUEEZE (the v2 server): every return costs both paddles `per` px, down to `min`, for the rest of the point */
  squeeze: { per: number; min: number } | null;
  /** GOLDEN BALL: the chance a serve is the jackpot ball (0/absent: never) */
  golden?: number;
  /** TARGET PRACTICE: no right paddle - a back wall, and targets to shoot */
  targets?: boolean;
  /** a clock (ticks of live play) that ends the match */
  timeLimit?: number;
  /** THE GAUNTLET: a boss's house rules (game/gauntlet.ts) */
  boss?: BossRules;
  bulletTime: boolean;
  freeze: { scale: number; ticks: number };
}

/**
 * THE GAUNTLET: what makes a boss fight different from the lab. Every one is
 * built from the lab's own physics - a boss is a set of house rules, not a
 * new game.
 */
export interface BossRules {
  /** each side's paddle height, x the normal (THE WALL) */
  size?: Partial<Record<Side, number>>;
  /** an experiment that never stops: it re-forms `foreverGap` ticks after it ends */
  forever?: ExperimentName;
  foreverGap?: number;
  /** every serve splits into three (HYDRA) */
  serveSplit?: boolean;
  /** experiments every this many ticks (instead of every 20-29s) */
  expEvery?: number;
  /** ...and always in their ascended form */
  alwaysGod?: boolean;
}

export const CLASSIC_RULES: Rules = {
  name: "classic",
  winScore: 3,
  serveSpeed: 8,
  maxSpeed: 27,
  speedUp: 0.035,
  maxVy: 10,
  curve: null,
  orbs: false,
  experiments: false,
  hitstop: false,
  contactStop: 2,
  squeeze: { per: 2.5, min: 66 },
  bulletTime: false,
  freeze: { scale: 0.0333, ticks: 78 },
};

export const CHAOS_RULES: Rules = {
  name: "chaos",
  winScore: 7,
  serveSpeed: 9,
  maxSpeed: 36,
  speedUp: 0.045,
  maxVy: 14,
  curve: CHAOS_CURVE,
  orbs: true,
  experiments: true,
  hitstop: true,
  contactStop: 2,
  squeeze: null,
  bulletTime: true,
  freeze: { scale: 0.18, ticks: 120 },
  golden: 0.09,
};

/**
 * RALLY RUSH: endless score attack. Professor BEAR plays it WITH you (a
 * cooperative return every time), you have three lives, and the rally just
 * keeps getting faster and tighter - the ramp is gentler than the lab's, the
 * cap is higher, and both paddles squeeze as the rally runs.
 */
/**
 * TARGET PRACTICE: the accuracy game. Sixty seconds, a back wall where the
 * professor would be, and targets in the far half of the court - aim your
 * returns into them (angle off the face, english, curve). The ball passes
 * through what it hits, so one great shot can take out two or three. A
 * dropped ball re-serves at once (no countdown); the clock only runs in play.
 * Targets shrink and start to move as you score.
 */
export const TARGET_RULES: Rules = {
  ...CHAOS_RULES,
  winScore: 9999,
  serveSpeed: 9,
  speedUp: 0.02,
  maxSpeed: 26,
  orbs: false,
  experiments: false,
  golden: 0,
  squeeze: null,
  targets: true,
  timeLimit: 60 * 60,
};

export const RUSH_RULES: Rules = {
  ...CHAOS_RULES,
  winScore: 3,
  serveSpeed: 8,
  speedUp: 0.028,
  maxSpeed: 40,
  squeeze: { per: 0.9, min: 70 },
  golden: 0.18,
};

export interface SimBall {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number;
  lastHit: Side | null;
  fire: boolean;
  ghostFor: Side | null;
  ghostTicks: number;
  warpCd: number;
  stuck: { side: Side; ticks: number; offset: number; clone?: boolean } | null;
  /** PRISM: this ray's colour (null: an ordinary ball) */
  hue: number | null;
  /** PLASMA: a god-tier fireball, hotter and faster */
  plasma: boolean;
  /** QUANTUM: superposition group (0: a real, observed ball) */
  phantom: number;
  /** ticks since a paddle last struck it - drives the curve's late break */
  age: number;
  /** GOLDEN BALL: the jackpot point */
  golden?: boolean;
  /** TARGET PRACTICE: the last return off a paddle was a BULLSEYE */
  ace?: boolean;
  /**
   * LAG GRACE (online): the ball reached a face the defender's paddle was not
   * at - yet. It waits there for up to `ticks` for their paddle to arrive over
   * the network; `graced`: it already waited once this flight (now it goes by).
   */
  pending?: { side: Side; crossY: number; ticks: number } | null;
  graced?: boolean;
}

export interface SimTarget {
  id: number;
  x: number;
  y: number;
  baseY: number;
  r: number;
  value: number;
  kind: "normal" | "small" | "gold";
  /** moving targets bob up and down */
  amp: number;
  ph: number;
  sp: number;
}

export interface SimOrb { id: number; type: OrbType; x: number; y: number; ticks: number; god: boolean }
export interface Portals { a: { x: number; y: number }; b: { x: number; y: number }; ticks: number }
/** A black hole. It pulls, then COLLAPSES, then goes SUPERNOVA. */
export interface Well { x: number; y: number; ticks: number; phase: "pull" | "collapse" }
export interface Bumper { id: number; x: number; y: number; r: number; orbit?: { cx: number; cy: number; r: number; a: number; w: number } }
export interface Tesla { a: { x: number; y: number }; b: { x: number; y: number }; ticks: number }
/** `flipEvery` > 0: GRAVITY FLIP - it turns over every that many ticks. */
export interface Gravity { g: number; ticks: number; flipIn: number; flipEvery: number }
/** Two black holes on a decaying orbit. `r` shrinks faster the closer they get - the chirp. */
export interface Binary { cx: number; cy: number; r: number; angle: number; chirped: boolean }
/** One-way: in through the black mouth `a`, out of the white hole `b`, faster. */
export interface Wormhole { a: { x: number; y: number }; b: { x: number; y: number }; ticks: number }
export interface Prism { x: number; y: number; ticks: number }
/** Two tesla beams crossed through a core, turning like a turnstile. */
export interface Cage { cx: number; cy: number; len: number; angle: number; w: number; ticks: number }

const WELL_TICKS = 480;
const COLLAPSE_TICKS = 50;
const BINARY_R = 170;
/** inspiral: dr = K * (R0/r)^3 per tick, so the merger lands ~8.5s in */
const BINARY_K = 0.083;
const FINALE_TICKS = 80;
const FINALE_SCALE = 0.1;
/** QUANTUM: a superposition is observed at these lines, or after this long */
const OBSERVE = { left: 330, right: 950, ticks: 44 };

interface SimPaddle {
  y: number;
  hist: number[];
  vy: number;
  megaTicks: number;
  shrinkTicks: number;
  magnet: boolean;
  power: boolean;
  cloneTicks: number;
  used: Set<string>;
}

export type SimEvent =
  | { type: "countdown"; count: number }
  | { type: "game_over"; winner: Side; finalScore: { left: number; right: number } }
  | { type: "edge_hit"; side: Side; hitPosition: number }
  | { type: "ultimate_activated"; side: Side; abilityType: string }
  | { type: "powerups_refreshed" }
  | { type: "error"; message: string }
  | { type: "chaos"; kind: "perfect"; side: Side }
  | { type: "chaos"; kind: "curve"; side: Side; spin: number; strength: number }
  | { type: "chaos"; kind: "orb_spawn"; orb: SimOrb }
  | { type: "chaos"; kind: "orb_taken"; orb: OrbType; side: Side; x: number; y: number; god: boolean }
  | { type: "chaos"; kind: "multiball"; count: number }
  | { type: "chaos"; kind: "warp"; from: { x: number; y: number }; to: { x: number; y: number } }
  | { type: "chaos"; kind: "experiment"; name: ExperimentName; n: number; god: boolean }
  | { type: "chaos"; kind: "hitstop"; ticks: number }
  | { type: "chaos"; kind: "clutch"; side: Side }
  | { type: "chaos"; kind: "magnet"; side: Side; phase: "catch" | "release" }
  | { type: "chaos"; kind: "fire_out"; side: Side }
  | { type: "chaos"; kind: "supernova"; x: number; y: number }
  | { type: "chaos"; kind: "collapse"; x: number; y: number }
  | { type: "chaos"; kind: "bumper"; x: number; y: number; side: Side | null }
  | { type: "chaos"; kind: "zap"; x: number; y: number; side: Side | null }
  | { type: "chaos"; kind: "clone_save"; side: Side }
  | { type: "chaos"; kind: "sudden_death" }
  | { type: "chaos"; kind: "inspiral"; x: number; y: number }
  | { type: "chaos"; kind: "merger"; x: number; y: number }
  | { type: "chaos"; kind: "wormhole"; from: { x: number; y: number }; to: { x: number; y: number } }
  | { type: "chaos"; kind: "prism"; x: number; y: number; count: number }
  | { type: "chaos"; kind: "gravity_flip"; g: number }
  | { type: "chaos"; kind: "quantum"; x: number; y: number }
  | { type: "chaos"; kind: "quantum_collapse"; x: number; y: number; gone: { x: number; y: number }[] }
  | { type: "chaos"; kind: "finale"; x: number; y: number; scorer: Side }
  | { type: "chaos"; kind: "bullet_bend"; side: Side; x: number; y: number; spin: number }
  | { type: "chaos"; kind: "bullseye"; side: Side; x: number; y: number }
  | { type: "chaos"; kind: "golden" }
  | { type: "chaos"; kind: "target"; x: number; y: number; value: number; tkind: SimTarget["kind"]; curved: boolean; ace: boolean }
  | { type: "chaos"; kind: "backwall"; y: number }
  | { type: "chaos"; kind: "time_warn"; left: number }
  | { type: "chaos"; kind: "kick"; x: number; y: number; kick: number; side: Side | null };

/** The seven experiments; each has an ascended form (GOD_FORM). */
export const EXPERIMENT_POOL: readonly ExperimentName[] = ["BLACK HOLE", "PORTALS", "MULTIBALL", "HYPERDRIVE", "GRAVITY STORM", "PINBALL", "TESLA GATE"];
/** a match's first experiment is always one of these - the black hole, the signature, half the time */
export const HEADLINERS: readonly ExperimentName[] = ["BLACK HOLE", "BLACK HOLE", "MULTIBALL", "PORTALS"];
/** the first experiment, 10s of live play in (the first point stays pure pong) */
export const EXP_FIRST = 600;
/** ...then one every 14-19s */
export const EXP_EVERY = 840;
export const EXP_JITTER = 300;

/** mulberry32 */
export function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Do segments p1-p2 and p3-p4 intersect? */
export function segmentsCross(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number): boolean {
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
  const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

const R = FIELD.BALL / 2;

/**
 * Keep a ball moving across the court: |vx| at least `ratio` of its speed
 * (and at least `floor`, within the speed), WITHOUT changing the speed -
 * raising vx alone used to add energy every tick it applied.
 */
function keepHorizontal(b: { vx: number; vy: number }, ratio: number, floor = 0): void {
  const s = Math.hypot(b.vx, b.vy);
  if (s < 1e-6) return;
  const min = Math.min(s, Math.max(s * ratio, floor));
  if (Math.abs(b.vx) >= min) return;
  const vx = Math.sign(b.vx || 1) * min;
  b.vy = Math.sign(b.vy || 1) * Math.sqrt(Math.max(0, s * s - vx * vx));
  b.vx = vx;
}
/** a paddle further than this from the crossing cannot get there: no lag grace (the server's GRACE.reach) */
const GRACE_REACH = 280;
const L_FACE = FIELD.PADDLE_INSET + FIELD.PADDLE_W;
const R_FACE = FIELD.W - FIELD.PADDLE_INSET - FIELD.PADDLE_W;
const other = (s: Side): Side => (s === "left" ? "right" : "left");

const ORB_WEIGHTS: [OrbType, number][] = [
  ["split", 3], ["fire", 3], ["mega", 2], ["shrink", 2], ["magnet", 2], ["warp", 1.5], ["hole", 1.5], ["ghost", 1], ["mirror", 1.6],
];

export class PongSim {
  readonly rules: Rules;
  private rng: () => number;
  tick = 0;
  balls: SimBall[] = [];
  orbs: SimOrb[] = [];
  portals: Portals | null = null;
  well: Well | null = null;
  bumpers: Bumper[] = [];
  bumperTicks = 0;
  tesla: Tesla | null = null;
  gravity: Gravity | null = null;
  binary: Binary | null = null;
  wormhole: Wormhole | null = null;
  prism: Prism | null = null;
  cage: Cage | null = null;
  suddenDeath = false;
  paddles: Record<Side, SimPaddle>;
  score = { left: 0, right: 0 };
  phase: "countdown" | "live" | "over" = "countdown";
  rally = 0;
  /**
   * LAG GRACE, per side, in ticks (0: none - the lab, where the paddle is local).
   * An online session sets it from each player's measured round trip: a ball
   * that reaches a face waits that long for the defender's paddle to arrive
   * before it is a miss - the live server's rule (GameSession's GRACE).
   */
  graceTicks: Record<Side, number> = { left: 0, right: 0 };
  /** TARGET PRACTICE */
  targets: SimTarget[] = [];
  targetHits = 0;
  /** ticks of live play so far (the clock) */
  playTicks = 0;
  /** a dropped ball comes back after this many ticks (no countdown) */
  private reserveTicks = 0;
  private count = 3;
  private countTicks = 0;
  private parked = { x: FIELD.W / 2, y: FIELD.H / 2 };
  private nextId = 1;
  private freezeTicks = 0;
  private slowTicks = 0;
  private hitstopTicks = 0;
  private hyperTicks = 0;
  private hyperScale = 1.4;
  private finaleTicks = 0;
  private finaleFired = false;
  private lastBend = -Infinity;
  /** who scored the deciding goal - not "whoever has more" afterwards */
  private winner: Side | null = null;
  private qGroups = new Map<number, number>();
  /** Everything that pulls (or pushes) this tick: k > 0 pulls, k < 0 pushes. */
  private pullCache: { x: number; y: number; k: number; reach: number }[] = [];
  private orbTimer = 360;
  private expTimer = EXP_FIRST;
  private expCount = 0;
  /** this match's experiments, dealt from a shuffled deck (see deal()) */
  private expBag: ExperimentName[] = [];
  private overTicks = -1;
  private events: SimEvent[] = [];
  /** THE GAUNTLET: ticks until a boss's forever-experiment re-forms, and how often it has */
  private foreverGap = 45;
  private foreverRuns = 0;

  constructor(rules: Rules = CLASSIC_RULES, seed = 1) {
    this.rules = rules;
    this.rng = rngFrom(seed);
    if (rules.boss?.expEvery) this.expTimer = rules.boss.expEvery;
    const pad = (): SimPaddle => ({ y: FIELD.H / 2, hist: [], vy: 0, megaTicks: 0, shrinkTicks: 0, magnet: false, power: false, cloneTicks: 0, used: new Set() });
    this.paddles = { left: pad(), right: pad() };
  }

  // ------------------------------------------------------------- control
  /** Kick off the opening countdown (3, 2, 1, GO). */
  start(): void {
    this.beginCountdown(false);
  }

  paddleHeight(side: Side): number {
    const p = this.paddles[side];
    const sq = this.rules.squeeze;
    const base = sq ? Math.max(sq.min, FIELD.PADDLE_H - sq.per * this.rally) : FIELD.PADDLE_H;
    return base * (this.rules.boss?.size?.[side] ?? 1) * (p.megaTicks > 0 ? 1.6 : 1) * (p.shrinkTicks > 0 ? 0.58 : 1);
  }

  setPaddle(side: Side, y: number): void {
    if (!Number.isFinite(y)) return;
    const h = this.paddleHeight(side) / 2;
    this.paddles[side].y = Math.max(h, Math.min(FIELD.H - h, y));
  }

  useUltimate(side: Side, type: string): boolean {
    const p = this.paddles[side];
    if (p.used.has(type)) {
      this.emit({ type: "error", message: "Ultimate already used!" });
      return false;
    }
    p.used.add(type);
    if (type === "time_freeze") this.freezeTicks = this.rules.freeze.ticks;
    else if (type === "power_hit") p.power = true;
    else if (type === "paddle_dash") {
      const target = this.nearestIncoming(side);
      if (target) this.setPaddle(side, target.y);
    }
    this.emit({ type: "ultimate_activated", side, abilityType: type });
    return true;
  }

  drain(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  get timeScale(): number {
    return (this.freezeTicks > 0 ? this.rules.freeze.scale : 1) * (this.slowTicks > 0 ? 0.3 : 1) * (this.hyperTicks > 0 ? this.hyperScale : 1) * (this.finaleTicks > 0 ? FINALE_SCALE : 1);
  }

  get held(): boolean {
    return this.hitstopTicks > 0;
  }

  /** Freeze a live ball in place for `ticks` (resuming from a pause). */
  holdFor(ticks: number): void {
    if (this.phase === "live") this.hitstopTicks = Math.max(this.hitstopTicks, ticks);
  }

  // ---------------------------------------------------------------- tick
  step(): void {
    this.tick++;
    for (const side of ["left", "right"] as Side[]) {
      const p = this.paddles[side];
      p.hist.push(p.y);
      if (p.hist.length > 4) p.hist.shift();
      p.vy = p.hist.length > 1 ? (p.y - p.hist[0]) / (p.hist.length - 1) : 0;
      if (p.megaTicks > 0) p.megaTicks--;
      if (p.shrinkTicks > 0) p.shrinkTicks--;
      if (p.cloneTicks > 0) p.cloneTicks--;
    }

    if (this.phase === "over") {
      if (this.overTicks > 0 && --this.overTicks === 0) {
        const winner: Side = this.winner ?? (this.score.left > this.score.right ? "left" : "right");
        this.emit({ type: "game_over", winner, finalScore: { ...this.score } });
      }
      return;
    }

    if (this.phase === "countdown") {
      if (--this.countTicks <= 0) {
        this.count--;
        this.emit({ type: "countdown", count: Math.max(0, this.count) });
        if (this.count <= 0) {
          this.serve();
          this.phase = "live";
        } else this.countTicks = 60;
      }
      return;
    }

    if (this.hitstopTicks > 0) {
      this.hitstopTicks--;
      return;
    }

    const scale = this.timeScale;
    if (this.freezeTicks > 0) this.freezeTicks--;
    if (this.slowTicks > 0) this.slowTicks--;
    if (this.hyperTicks > 0) this.hyperTicks--;
    if (this.finaleTicks > 0) this.finaleTicks--;

    if (this.rules.targets) {
      if (this.tickTargets()) return; // the clock ran out
    }
    this.tickBodies(scale);
    this.pullCache = this.pulls();
    for (const b of [...this.balls]) {
      if ((this.phase as string) === "over") break; // the match was decided by an earlier ball this tick
      this.stepBall(b, scale);
    }
    if (this.phase !== "live") return;

    this.tickQuantum();
    this.tickWell();
    this.tickBinary(scale);
    if (this.portals && --this.portals.ticks <= 0) this.portals = null;
    if (this.wormhole && --this.wormhole.ticks <= 0) this.wormhole = null;
    if (this.prism && --this.prism.ticks <= 0) this.prism = null;
    if (this.tesla && --this.tesla.ticks <= 0) this.tesla = null;
    if (this.cage && --this.cage.ticks <= 0) this.cage = null;
    if (this.gravity) {
      const g = this.gravity;
      if (--g.ticks <= 0) this.gravity = null;
      else if (g.flipEvery && --g.flipIn <= 0) {
        // GRAVITY FLIP: the whole court turns over
        g.g = -g.g;
        g.flipIn = g.flipEvery;
        this.emit({ type: "chaos", kind: "gravity_flip", g: g.g });
      }
    }
    if (this.bumpers.length && --this.bumperTicks <= 0) this.bumpers = [];
    if (this.rules.orbs) this.tickOrbs();
    if (this.rules.experiments && --this.expTimer <= 0) this.experiment();
    if (this.rules.boss?.forever) this.keepForever(this.rules.boss.forever);
  }

  /** THE GAUNTLET: a boss's experiment never stops - it re-forms soon after it ends. */
  private keepForever(name: ExperimentName): void {
    if (this.experimentActive(name)) {
      this.foreverGap = this.rules.boss?.foreverGap ?? 45;
      return;
    }
    if (--this.foreverGap > 0) return;
    // announced once, the first time; after that it is simply the weather
    this.runExperiment(name, this.foreverRuns++ > 0);
  }

  private experimentActive(name: ExperimentName): boolean {
    switch (name) {
      case "BLACK HOLE": return !!this.well;
      case "BINARY BLACK HOLES": return !!this.binary;
      case "PORTALS": return !!this.portals;
      case "WORMHOLE": return !!this.wormhole;
      case "PRISM": return !!this.prism;
      case "HYPERDRIVE": case "LIGHTSPEED": return this.hyperTicks > 0;
      case "GRAVITY STORM": case "GRAVITY FLIP": return !!this.gravity;
      case "PINBALL": case "ORRERY": return this.bumpers.length > 0;
      case "TESLA GATE": return !!this.tesla;
      case "TESLA CAGE": return !!this.cage;
      case "MULTIBALL": return this.balls.length > 1;
    }
  }

  private stepBall(b: SimBall, scale: number): void {
    if (b.pending) {
      // LAG GRACE: held on the face while the defender's paddle is on its way
      const g = b.pending;
      const p = this.paddles[g.side];
      const h = this.paddleHeight(g.side);
      if (g.crossY >= p.y - h / 2 - R && g.crossY <= p.y + h / 2 + R) {
        b.pending = null;
        this.tryHit(b, g.side, g.crossY);
        return;
      }
      if (--g.ticks > 0) return;
      // it did not come: the ball goes by
      b.pending = null;
      b.graced = true;
    }
    if (b.stuck) {
      const s = b.stuck;
      const p = this.paddles[s.side];
      const anchor = s.clone ? (this.cloneY(s.side) ?? p.y) : p.y;
      b.x = s.side === "left" ? L_FACE + R + 1 : R_FACE - R - 1;
      b.y = Math.max(R, Math.min(FIELD.H - R, anchor + s.offset));
      if (--s.ticks <= 0) this.releaseMagnet(b);
      return;
    }

    const px = b.x;
    const py = b.y;

    if (this.rules.curve && b.spin) b.spin = applyCurve(b, b.spin, this.rules.curve, scale, b.age);
    b.age += scale;

    if (this.gravity) {
      // GRAVITY STORM: a real downward pull - shots become parabolas
      b.vy += this.gravity.g * scale;
      this.capSpeed(b);
    }

    if (this.pullCache.length) {
      const speed = Math.hypot(b.vx, b.vy);
      let bent = false;
      for (const pl of this.pullCache) {
        const dx = pl.x - b.x;
        const dy = pl.y - b.y;
        const raw = Math.hypot(dx, dy);
        if (raw > pl.reach) continue;
        const d = Math.max(70, raw);
        const a = (pl.k / (d * d)) * scale;
        b.vx += (dx / d) * a * speed * 0.12;
        b.vy += (dy / d) * a * speed * 0.12;
        bent = true;
      }
      if (bent) {
        // a gravity well bends, it never adds energy or stalls the ball
        const ns = Math.hypot(b.vx, b.vy) || 1;
        b.vx *= speed / ns;
        b.vy *= speed / ns;
        keepHorizontal(b, 0.35);
      }
    }

    b.x += b.vx * scale;
    b.y += b.vy * scale;

    for (const bm of this.bumpers) {
      const dx = b.x - bm.x;
      const dy = b.y - bm.y;
      const d = Math.hypot(dx, dy);
      if (d < bm.r + R && d > 0.001) {
        // PINBALL: reflect off the bumper's surface and kick harder
        const nx = dx / d;
        const ny = dy / d;
        const dot = b.vx * nx + b.vy * ny;
        if (dot < 0) {
          b.vx -= 2 * dot * nx;
          b.vy -= 2 * dot * ny;
          const k = Math.min(1.1, this.rules.maxSpeed / (Math.hypot(b.vx, b.vy) || 1));
          b.vx *= k;
          b.vy *= k;
          keepHorizontal(b, 0.3, 4); // never stall in the bumper field - and never add speed doing it
        }
        b.x = bm.x + nx * (bm.r + R + 0.5);
        b.y = bm.y + ny * (bm.r + R + 0.5);
        this.emit({ type: "chaos", kind: "bumper", x: bm.x, y: bm.y, side: b.lastHit });
      }
    }

    if (this.tesla && b.warpCd <= 0) {
      // TESLA GATE: crossing the live beam electrifies the ball
      const { a: ta, b: tb } = this.tesla;
      if (segmentsCross(px, py, b.x, b.y, ta.x, ta.y, tb.x, tb.y)) {
        const s = Math.min(this.rules.maxSpeed, Math.hypot(b.vx, b.vy) * 1.22);
        const vy = (this.rng() < 0.5 ? -1 : 1) * (5 + this.rng() * 6);
        b.vy = vy;
        b.vx = Math.sign(b.vx || 1) * Math.sqrt(Math.max(16, s * s - vy * vy));
        b.warpCd = 10;
        this.emit({ type: "chaos", kind: "zap", x: b.x, y: b.y, side: b.lastHit });
      }
    }
    if (this.cage && b.warpCd <= 0 && this.crossesCage(px, py, b.x, b.y, scale)) this.electrify(b);

    if (b.y < R || b.y > FIELD.H - R) {
      const wall: 1 | -1 = b.y > FIELD.H - R ? 1 : -1;
      b.y = wall < 0 ? R + (R - b.y) : FIELD.H - R - (b.y - (FIELD.H - R));
      // THE KICK: a spinning ball skids on or checks up off the wall
      const r = wallBounce(b, b.spin, this.rules.curve, wall, this.rules.maxSpeed);
      b.spin = r.spin;
      if (Math.abs(r.kick) > 0.06 && !b.phantom) this.emit({ type: "chaos", kind: "kick", x: b.x, y: b.y, kick: r.kick, side: b.lastHit });
    }

    if (b.ghostTicks > 0 && --b.ghostTicks === 0) b.ghostFor = null;
    if (b.warpCd > 0) b.warpCd--;
    // a superposition only moves; it cannot touch anything until observed
    if (b.phantom) return;
    if (this.wormhole && b.warpCd <= 0) {
      const { a, b: out } = this.wormhole;
      if (Math.hypot(b.x - a.x, b.y - a.y) < 34) {
        const from = { x: b.x, y: b.y };
        const s = Math.hypot(b.vx, b.vy) || 1;
        const k = Math.min(1.3, this.rules.maxSpeed / s);
        b.vx *= k;
        b.vy *= k;
        b.x = out.x + (b.vx / (s * k)) * 50;
        b.y = Math.max(R, Math.min(FIELD.H - R, out.y + (b.vy / (s * k)) * 50));
        b.warpCd = 30;
        this.emit({ type: "chaos", kind: "wormhole", from, to: { x: out.x, y: out.y } });
      }
    }
    if (this.prism && Math.hypot(b.x - this.prism.x, b.y - this.prism.y) < 42) {
      const { x, y } = this.prism;
      this.prism = null;
      this.disperse(b, x, y);
    }
    if (this.portals && b.warpCd <= 0) {
      const { a, b: pb } = this.portals;
      const near = (q: { x: number; y: number }) => Math.hypot(b.x - q.x, b.y - q.y) < 36;
      const from = near(a) ? a : near(pb) ? pb : null;
      if (from) {
        const to = from === a ? pb : a;
        this.emit({ type: "chaos", kind: "warp", from: { x: b.x, y: b.y }, to: { x: to.x, y: to.y } });
        b.x = to.x + Math.sign(b.vx) * 40;
        b.y = to.y;
        b.warpCd = 24;
      }
    }

    for (const o of [...this.orbs]) {
      if (Math.hypot(b.x - o.x, b.y - o.y) < 36) this.takeOrb(o, b);
    }

    // swept paddle collision against the face plane
    if (b.vx < 0 && px - R >= L_FACE - 0.001 && b.x - R < L_FACE) {
      const t = (px - R - L_FACE) / (px - b.x || 1);
      this.tryHit(b, "left", py + (b.y - py) * t);
    } else if (this.rules.targets) {
      // TARGET PRACTICE: the back wall returns it; targets in its path are hit
      for (const t of [...this.targets]) {
        if (Math.hypot(b.x - t.x, b.y - t.y) < t.r + R) {
          this.targets = this.targets.filter((x) => x !== t);
          this.targetHits++;
          const max = this.rules.curve?.spinMax ?? 1;
          this.emit({ type: "chaos", kind: "target", x: t.x, y: t.y, value: t.value, tkind: t.kind, curved: Math.abs(b.spin) > max * 0.3, ace: !!b.ace });
          this.spawnTarget();
        }
      }
      if (b.x > FIELD.W - R && b.vx > 0) {
        b.x = 2 * (FIELD.W - R) - b.x;
        b.vx = -Math.abs(b.vx);
        if (this.rules.curve) b.spin *= this.rules.curve.wallKeep;
        this.emit({ type: "chaos", kind: "backwall", y: b.y });
      }
    } else if (b.vx > 0 && px + R <= R_FACE + 0.001 && b.x + R > R_FACE) {
      const t = (R_FACE - (px + R)) / (b.x - px || 1);
      this.tryHit(b, "right", py + (b.y - py) * t);
    }

    // FINAL BALL: the shot that wins the match is past the last paddle
    if (!this.finaleFired && this.rules.experiments) {
      const lost: Side | null = b.vx < 0 && b.x - R < L_FACE - 1 ? "left" : b.vx > 0 && b.x + R > R_FACE + 1 ? "right" : null;
      const inPlay = this.balls.filter((x) => !x.phantom).length;
      if (lost && inPlay === 1 && this.score[other(lost)] + 1 >= this.rules.winScore) {
        this.finaleFired = true;
        this.finaleTicks = FINALE_TICKS;
        this.emit({ type: "chaos", kind: "finale", x: b.x, y: b.y, scorer: other(lost) });
      }
    }

    if (b.x < -30) this.goal(b, "right");
    else if (b.x > FIELD.W + 30) this.goal(b, "left");
  }

  /** Where the MIRROR clone of a paddle sits (reflected about the middle). */
  cloneY(side: Side): number | null {
    const p = this.paddles[side];
    return p.cloneTicks > 0 ? FIELD.H - p.y : null;
  }

  private tryHit(b: SimBall, side: Side, crossY: number): void {
    const p = this.paddles[side];
    const h = this.paddleHeight(side);
    let py = p.y;
    if (crossY < p.y - h / 2 - R || crossY > p.y + h / 2 + R) {
      const cy = this.cloneY(side);
      if (cy === null || crossY < cy - h / 2 - R || crossY > cy + h / 2 + R) {
        // a miss - unless, online, the defender's paddle may still be on its way
        const wait = this.graceTicks[side];
        if (wait > 0 && !b.graced && Math.abs(crossY - p.y) <= GRACE_REACH) {
          b.pending = { side, crossY, ticks: wait };
          b.x = side === "left" ? L_FACE + R : R_FACE - R;
          b.y = crossY;
        }
        return;
      }
      py = cy; // saved by the mirror clone
      this.emit({ type: "chaos", kind: "clone_save", side });
    }

    const hp = Math.max(-1, Math.min(1, (crossY - py) / (h / 2)));
    const speed = Math.hypot(b.vx, b.vy);
    const perfect = Math.abs(hp) <= 0.15;
    const bullseye = Math.abs(hp) <= BULLSEYE;
    b.ace = bullseye;
    b.graced = false;
    const edge = Math.abs(hp) >= 0.7;
    const dir = side === "left" ? 1 : -1;

    b.x = side === "left" ? L_FACE + R + 1 : R_FACE - R - 1;
    b.y = crossY;
    b.vx = dir * Math.abs(b.vx);
    let spinStrength = speed >= 10 ? 1.05 : 1.575;
    if (edge) spinStrength *= 1.8;
    // ENGLISH: the face drags the ball the way the paddle is moving
    b.vy = Math.max(-this.rules.maxVy, Math.min(this.rules.maxVy, b.vy + hp * spinStrength + englishFor(p.vy, this.rules.curve)));
    if (Math.abs(b.vx) < speed) b.vx = dir * speed;

    let ups = 1 + (perfect ? 1 : 0) + (bullseye ? 1 : 0) + (this.suddenDeath ? 1 : 0);
    const powered = p.power;
    if (powered) { ups += 3; p.power = false; }
    for (let i = 0; i < ups; i++) this.speedUp(b);
    this.capSpeed(b);
    if (b.fire) {
      if (b.lastHit && b.lastHit !== side) {
        b.fire = false; // returning a fireball puts it out
        b.plasma = false;
        this.emit({ type: "chaos", kind: "fire_out", side });
      }
    }

    if (edge) this.emit({ type: "edge_hit", side, hitPosition: hp });
    if (perfect) this.emit({ type: "chaos", kind: "perfect", side });
    if (bullseye) this.emit({ type: "chaos", kind: "bullseye", side, x: b.x, y: b.y });

    let curveStrength = 0;
    if (this.rules.curve) {
      const s = spinFromSwing(p.vy, this.rules.curve);
      b.spin = s !== 0 ? s : b.spin * 0.3;
      curveStrength = Math.abs(s) / this.rules.curve.spinMax;
      if (curveStrength > 0.2) this.emit({ type: "chaos", kind: "curve", side, spin: s, strength: curveStrength });
    }

    b.lastHit = side;
    b.age = 0;
    this.rally++;

    if (p.magnet) {
      p.magnet = false;
      const clone = py !== p.y; // caught by the MIRROR clone: ride the clone
      b.stuck = { side, ticks: 42, offset: crossY - py, clone };
      this.emit({ type: "chaos", kind: "magnet", side, phase: "catch" });
    }

    if (this.rules.hitstop && (perfect || powered || curveStrength > 0.6 || (edge && speed > 18))) {
      // the harder the bend, the longer the world holds its breath
      this.hitstopTicks = powered ? 7 : curveStrength >= 0.9 ? 6 : curveStrength > 0.6 ? 4 : 3;
      this.emit({ type: "chaos", kind: "hitstop", ticks: this.hitstopTicks });
    } else if (this.rules.contactStop) {
      // every return lands: the ball sits on the face a beat before it flies
      this.hitstopTicks = Math.max(this.hitstopTicks, this.rules.contactStop);
    }
    // BULLET BEND: a maximal swing gets a beat of bullet time to watch it break
    if (this.rules.bulletTime && curveStrength >= 0.9 && this.tick - this.lastBend > 240) {
      this.lastBend = this.tick;
      this.slowTicks = Math.max(this.slowTicks, 26);
      this.emit({ type: "chaos", kind: "bullet_bend", side, x: b.x, y: b.y, spin: b.spin });
    }
    if (this.rules.bulletTime && edge && speed > 15) {
      this.slowTicks = 26;
      this.emit({ type: "chaos", kind: "clutch", side });
    }
  }

  /**
   * Hard speed cap. The return logic (copied from the server) forces |vx| up
   * to the incoming speed and THEN adds the angle to vy, so every return at
   * the cap nudged the total speed a little higher - a measured run reached
   * 51.9 against a cap of 36. Clamp the vector, keep the direction.
   */
  private capSpeed(b: SimBall): void {
    const s = Math.hypot(b.vx, b.vy);
    if (s > this.rules.maxSpeed) {
      const k = this.rules.maxSpeed / s;
      b.vx *= k;
      b.vy *= k;
    }
  }

  private speedUp(b: SimBall): void {
    const speed = Math.hypot(b.vx, b.vy);
    if (speed >= this.rules.maxSpeed) return;
    const k = Math.min(1 + this.rules.speedUp, this.rules.maxSpeed / speed);
    b.vx *= k;
    b.vy *= k;
  }

  private releaseMagnet(b: SimBall): void {
    const s = b.stuck!;
    const p = this.paddles[s.side];
    b.stuck = null;
    const dir = s.side === "left" ? 1 : -1;
    const speed = Math.max(this.rules.serveSpeed + 4, Math.hypot(b.vx, b.vy) * 1.15);
    // aimed shot: the paddle's motion at release steers it
    const vy = Math.max(-this.rules.maxVy, Math.min(this.rules.maxVy, p.vy * 0.6));
    b.vy = vy;
    b.vx = dir * Math.sqrt(Math.max(1, speed * speed - vy * vy));
    this.capSpeed(b);
    if (this.rules.curve) b.spin = spinFromSwing(p.vy, this.rules.curve);
    this.emit({ type: "chaos", kind: "magnet", side: s.side, phase: "release" });
  }

  private goal(b: SimBall, scorer: Side): void {
    this.balls = this.balls.filter((x) => x !== b);
    if (this.phase === "over") return; // already decided: no goals after the winner
    if (this.rules.targets) {
      // a drop: counted, and the launcher serves again in a moment - no countdown
      this.parked = { x: Math.max(-10, Math.min(FIELD.W + 10, b.x)), y: b.y };
      this.score[scorer]++;
      this.rally = 0;
      if (this.balls.length === 0) this.reserveTicks = 50;
      return;
    }
    this.parked = { x: Math.max(-10, Math.min(FIELD.W + 10, b.x)), y: b.y };
    this.score[scorer]++;
    if (this.score[scorer] >= this.rules.winScore) {
      this.phase = "over";
      this.winner = scorer;
      this.overTicks = 36;
      return;
    }
    const brink = this.rules.winScore - 1;
    if (this.rules.experiments && !this.suddenDeath && this.score.left === brink && this.score.right === brink) {
      // SUDDEN DEATH: next point wins, and every return speeds up twice
      this.suddenDeath = true;
      this.emit({ type: "chaos", kind: "sudden_death" });
    }
    if (this.balls.length === 0) this.beginCountdown(true);
  }

  private beginCountdown(afterPoint: boolean): void {
    this.phase = "countdown";
    this.count = 4; // the first tick announces 3
    this.countTicks = 1;
    this.rally = 0;
    this.freezeTicks = this.slowTicks = this.hitstopTicks = this.hyperTicks = 0;
    this.well = null;
    this.portals = null;
    this.tesla = null;
    this.gravity = null;
    this.binary = null;
    this.wormhole = null;
    this.prism = null;
    this.cage = null;
    this.qGroups.clear();
    this.foreverGap = this.rules.boss?.foreverGap ?? 45;
    this.hyperScale = 1.4;
    this.finaleTicks = 0;
    this.bumpers = [];
    this.orbs = [];
    for (const side of ["left", "right"] as Side[]) {
      const p = this.paddles[side];
      p.used.clear();
      p.power = false;
      p.magnet = false;
    }
    if (afterPoint) this.emit({ type: "powerups_refreshed" });
  }

  private serve(): void {
    const angle = (this.rng() * Math.PI) / 2 - Math.PI / 4;
    const dir = this.rules.targets ? -1 : this.rng() > 0.5 ? 1 : -1; // the launcher always serves to you
    this.balls = [this.newBall(FIELD.W / 2, FIELD.H / 2, Math.cos(angle) * this.rules.serveSpeed * dir, Math.sin(angle) * this.rules.serveSpeed)];
    if (this.rules.golden && this.rng() < this.rules.golden) {
      this.balls[0].golden = true;
      this.emit({ type: "chaos", kind: "golden" });
    }
    // HYDRA: every serve comes out as three
    if (this.rules.boss?.serveSplit) this.split(this.balls[0]);
  }

  /** TARGET PRACTICE: the clock, bobbing targets, and the quick re-serve. Returns true when time is up. */
  private tickTargets(): boolean {
    const limit = this.rules.timeLimit ?? Infinity;
    this.playTicks++;
    const left = Math.ceil((limit - this.playTicks) / 60);
    if ((limit - this.playTicks) % 60 === 0 && (left === 10 || left === 5)) this.emit({ type: "chaos", kind: "time_warn", left });
    if (this.playTicks >= limit) {
      this.balls = [];
      this.phase = "over";
      this.winner = "left";
      this.overTicks = 30;
      return true;
    }
    while (this.targets.length < 3) this.spawnTarget();
    for (const t of this.targets) {
      if (t.amp) t.y = Math.max(FIELD.WALL + t.r, Math.min(FIELD.H - FIELD.WALL - t.r, t.baseY + Math.sin(this.playTicks * t.sp + t.ph) * t.amp));
    }
    if (this.balls.length === 0 && this.reserveTicks > 0 && --this.reserveTicks === 0) this.serve();
    return false;
  }

  private spawnTarget(): void {
    const lvl = this.targetHits;
    const r0 = Math.max(22, 48 - lvl * 1.3);
    const roll = this.rng();
    const kind: SimTarget["kind"] = roll < 0.08 ? "gold" : roll < 0.3 ? "small" : "normal";
    const r = kind === "small" ? r0 * 0.65 : kind === "gold" ? r0 * 0.75 : r0;
    let x = 0;
    let y = 0;
    for (let i = 0; i < 24; i++) {
      x = 700 + this.rng() * 460;
      y = FIELD.WALL + r + 20 + this.rng() * (FIELD.H - 2 * (FIELD.WALL + r + 20));
      if (!this.targets.some((t) => Math.hypot(t.x - x, t.baseY - y) < t.r + r + 34)) break;
    }
    const moving = lvl >= 6 && this.rng() < Math.min(0.8, (lvl - 4) * 0.08);
    this.targets.push({
      id: this.nextId++, x, y, baseY: y, r, value: kind === "gold" ? 500 : kind === "small" ? 250 : 100, kind,
      amp: moving ? 50 + this.rng() * 90 : 0, ph: this.rng() * Math.PI * 2, sp: 0.02 + this.rng() * 0.03,
    });
  }

  private newBall(x: number, y: number, vx: number, vy: number): SimBall {
    return { id: this.nextId++, x, y, vx, vy, spin: 0, lastHit: null, fire: false, ghostFor: null, ghostTicks: 0, warpCd: 0, stuck: null, hue: null, plasma: false, phantom: 0, age: 0 };
  }

  // ---------------------------------------------------------------- chaos
  private tickOrbs(): void {
    for (const o of [...this.orbs]) if (--o.ticks <= 0) this.orbs = this.orbs.filter((x) => x !== o);
    if (--this.orbTimer > 0 || this.orbs.length >= 2) return;
    this.orbTimer = 300 + Math.floor(this.rng() * 240);
    let x = 0;
    let y = 0;
    for (let tries = 0; tries < 8; tries++) {
      x = 440 + this.rng() * 400;
      y = 110 + this.rng() * 500;
      if (this.balls.every((b) => Math.hypot(b.x - x, b.y - y) > 140)) break;
    }
    const god = this.godRoll();
    let type = this.pickOrb();
    if (god && type === "ghost") type = "quantum"; // the ghost ascends
    const orb: SimOrb = { id: this.nextId++, type, x, y, ticks: 540, god };
    this.orbs.push(orb);
    this.emit({ type: "chaos", kind: "orb_spawn", orb: { ...orb } });
  }

  private pickOrb(): OrbType {
    const total = ORB_WEIGHTS.reduce((a, [, w]) => a + w, 0);
    let r = this.rng() * total;
    for (const [t, w] of ORB_WEIGHTS) if ((r -= w) <= 0) return t;
    return "split";
  }

  private takeOrb(o: SimOrb, b: SimBall): void {
    this.orbs = this.orbs.filter((x) => x !== o);
    const taker: Side = b.lastHit ?? (b.vx > 0 ? "left" : "right");
    const rival = other(taker);
    // announce first: an orb that opens something reads as cause, then effect
    this.emit({ type: "chaos", kind: "orb_taken", orb: o.type, side: taker, x: o.x, y: o.y, god: o.god });
    switch (o.type) {
      case "split": if (o.god) this.disperse(b, o.x, o.y); else this.split(b); break;
      case "mega": this.paddles[taker].megaTicks = o.god ? 720 : 480; break;
      case "shrink": this.paddles[rival].shrinkTicks = o.god ? 720 : 480; break;
      case "fire": {
        b.fire = true;
        b.plasma = o.god; // PLASMA: hotter, faster
        const s = Math.hypot(b.vx, b.vy);
        const k = Math.min(o.god ? 1.45 : 1.3, this.rules.maxSpeed / s);
        b.vx *= k; b.vy *= k;
        break;
      }
      case "warp": if (o.god) this.openWormhole(); else this.openPortals(); break;
      case "hole": if (o.god) this.openBinary(); else this.openWell(); break;
      case "magnet": this.paddles[taker].magnet = true; break;
      case "ghost": b.ghostFor = rival; b.ghostTicks = 360; break;
      case "mirror": this.paddles[taker].cloneTicks = o.god ? 900 : 540; break;
      case "quantum": this.superpose(b); break;
    }
  }

  private split(b: SimBall): void {
    const speed = Math.hypot(b.vx, b.vy);
    const base = Math.atan2(b.vy, b.vx);
    const dir = Math.sign(b.vx || 1);
    for (const off of [-0.32, 0.32]) {
      const a = base + off;
      const nb = this.newBall(b.x, b.y, Math.cos(a) * speed, Math.sin(a) * speed);
      if (Math.sign(nb.vx) !== dir) nb.vx = dir * Math.abs(nb.vx);
      keepHorizontal(nb, 0.42);
      nb.lastHit = b.lastHit;
      nb.warpCd = 8;
      this.balls.push(nb);
    }
    this.emit({ type: "chaos", kind: "multiball", count: this.balls.length });
  }

  private openPortals(): void {
    this.portals = {
      a: { x: 430, y: 140 + this.rng() * 440 },
      b: { x: 850, y: 140 + this.rng() * 440 },
      ticks: 600,
    };
  }

  private openWell(): void {
    this.well = { x: FIELD.W / 2, y: FIELD.H / 2 + (this.rng() - 0.5) * 240, ticks: WELL_TICKS, phase: "pull" };
  }

  /** pull -> collapse (pulls 3x harder) -> SUPERNOVA (flings every ball out) */
  private tickWell(): void {
    const w = this.well;
    if (!w) return;
    if (--w.ticks > 0) return;
    if (w.phase === "pull") {
      w.phase = "collapse";
      w.ticks = COLLAPSE_TICKS;
      this.emit({ type: "chaos", kind: "collapse", x: w.x, y: w.y });
      return;
    }
    for (const b of this.balls) {
      if (b.stuck) continue;
      const dx = b.x - w.x;
      const dy = b.y - w.y;
      const d = Math.hypot(dx, dy) || 1;
      const s = Math.min(this.rules.maxSpeed, Math.hypot(b.vx, b.vy) * 1.35 + 3);
      let vx = (dx / d) * s;
      let vy = (dy / d) * s;
      // keep it playable: the blast always carries the ball toward a goal
      if (Math.abs(vx) < s * 0.45) {
        vx = Math.sign(vx || (b.x < FIELD.W / 2 ? -1 : 1)) * s * 0.45;
        vy = Math.sign(vy || 1) * Math.sqrt(Math.max(0, s * s - vx * vx));
      }
      b.vx = vx;
      b.vy = vy;
    }
    this.hitstopTicks = 6;
    this.emit({ type: "chaos", kind: "supernova", x: w.x, y: w.y });
    this.well = null;
  }

  private openBumpers(): void {
    const ys = [190, 360, 530];
    this.bumpers = [
      { id: this.nextId++, x: 520, y: ys[Math.floor(this.rng() * 3)], r: 30 },
      { id: this.nextId++, x: 760, y: ys[Math.floor(this.rng() * 3)], r: 30 },
      { id: this.nextId++, x: 640, y: 120 + this.rng() * 480, r: 36 },
    ];
    this.bumperTicks = 600;
  }

  private openTesla(): void {
    const x = 560 + this.rng() * 160;
    this.tesla = { a: { x, y: 70 }, b: { x: x + (this.rng() - 0.5) * 140, y: FIELD.H - 70 }, ticks: 540 };
  }

  /**
   * Late in the match, deep in a rally, in sudden death - or one time in
   * four anyway, so the first half sees them too - the lab goes GOD TIER.
   */
  private godRoll(): boolean {
    const late = Math.max(this.score.left, this.score.right) >= this.rules.winScore - 2;
    return this.suddenDeath || late || this.rally >= 16 || this.rng() < 0.25;
  }

  private experiment(): void {
    const boss = this.rules.boss;
    this.expTimer = boss?.expEvery ?? EXP_EVERY + Math.floor(this.rng() * EXP_JITTER);
    if (!this.expBag.length) this.expBag = this.deal();
    const base = this.expBag.pop()!;
    this.runExperiment(boss?.alwaysGod || this.godRoll() ? GOD_FORM[base] : base);
  }

  /**
   * A match's experiments come from a shuffled deck, not a dice roll: no
   * repeat until all seven have run, and the OPENER is always a headliner
   * (a black hole half the time, else multiball or portals). Measured by
   * scripts/health.ts: with
   * a dice roll every 20-29s from 20s in, an online match (first to 5, about
   * a minute of play) saw two experiments and 73% of them never a black hole.
   */
  private deal(): ExperimentName[] {
    const bag = [...EXPERIMENT_POOL];
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    if (this.expCount === 0) {
      // the opener (dealt from the end) is a headliner
      const h = HEADLINERS[Math.floor(this.rng() * HEADLINERS.length)];
      bag.splice(bag.indexOf(h), 1);
      bag.push(h);
    }
    return bag;
  }

  /** Start an experiment by name (public for tests and the dev harness). `quiet`: no announcement. */
  runExperiment(name: ExperimentName, quiet = false): void {
    this.expCount++;
    const sign = () => (this.rng() < 0.5 ? 1 : -1);
    switch (name) {
      case "BLACK HOLE": this.openWell(); break;
      case "PORTALS": this.openPortals(); break;
      case "MULTIBALL": { const b = this.realBall(); if (b) this.split(b); break; }
      case "HYPERDRIVE": this.hyperTicks = 360; this.hyperScale = 1.4; break;
      case "GRAVITY STORM": this.gravity = { g: 0.32 * sign(), ticks: 480, flipIn: 0, flipEvery: 0 }; break;
      case "PINBALL": this.openBumpers(); break;
      case "TESLA GATE": this.openTesla(); break;
      case "BINARY BLACK HOLES": this.openBinary(); break;
      case "WORMHOLE": this.openWormhole(); break;
      case "PRISM": this.openPrism(); break;
      case "LIGHTSPEED": this.hyperTicks = 300; this.hyperScale = 1.55; break;
      case "GRAVITY FLIP": this.gravity = { g: 0.3 * sign(), ticks: 600, flipIn: 110, flipEvery: 110 }; break;
      case "ORRERY": this.openOrrery(); break;
      case "TESLA CAGE": this.cage = { cx: FIELD.W / 2, cy: FIELD.H / 2, len: 250, angle: this.rng() * Math.PI, w: 0.014 * sign(), ticks: 600 }; break;
    }
    if (!quiet) this.emit({ type: "chaos", kind: "experiment", name, n: this.expCount, god: Object.values(GOD_FORM).includes(name) });
  }

  /** A ball genuinely in play: not a phantom, not caught, not already past a paddle. */
  private realBall(): SimBall | null {
    return this.balls.find((b) => !b.phantom && !b.stuck && b.x - R >= L_FACE && b.x + R <= R_FACE) ?? null;
  }

  // ------------------------------------------------------------ god tier
  private pulls(): { x: number; y: number; k: number; reach: number }[] {
    const out: { x: number; y: number; k: number; reach: number }[] = [];
    if (this.well) out.push({ x: this.well.x, y: this.well.y, k: this.well.phase === "collapse" ? 7800 : 2600, reach: Infinity });
    const bh = this.binaryHoles();
    if (bh) for (const h of bh) out.push({ x: h.x, y: h.y, k: 1500, reach: Infinity });
    if (this.wormhole) {
      out.push({ x: this.wormhole.a.x, y: this.wormhole.a.y, k: 1500, reach: 300 });
      out.push({ x: this.wormhole.b.x, y: this.wormhole.b.y, k: -1300, reach: 240 });
    }
    return out;
  }

  /** Bodies that move on their own: orbiting bumpers, the turning cage. */
  private tickBodies(scale: number): void {
    for (const bm of this.bumpers) {
      const o = bm.orbit;
      if (!o) continue;
      o.a += o.w * scale;
      bm.x = o.cx + Math.cos(o.a) * o.r;
      bm.y = o.cy + Math.sin(o.a) * o.r * 0.78;
    }
    if (this.cage) this.cage.angle += this.cage.w * scale;
  }

  /** Where the two holes of a binary sit right now. */
  binaryHoles(): [{ x: number; y: number }, { x: number; y: number }] | null {
    const bn = this.binary;
    if (!bn) return null;
    const dx = Math.cos(bn.angle) * bn.r;
    const dy = Math.sin(bn.angle) * bn.r * 0.62;
    return [{ x: bn.cx + dx, y: bn.cy + dy }, { x: bn.cx - dx, y: bn.cy - dy }];
  }

  private openBinary(): void {
    this.well = null;
    this.binary = { cx: FIELD.W / 2, cy: FIELD.H / 2 + (this.rng() - 0.5) * 120, r: BINARY_R, angle: this.rng() * Math.PI * 2, chirped: false };
  }

  /** The inspiral: they orbit faster and fall in faster - then MERGE. */
  private tickBinary(scale: number): void {
    const bn = this.binary;
    if (!bn) return;
    const q = BINARY_R / Math.max(bn.r, 1);
    bn.angle += Math.min(0.45, 0.03 * Math.pow(q, 1.5)) * scale;
    bn.r -= BINARY_K * q * q * q * scale;
    if (!bn.chirped && bn.r < 105) {
      bn.chirped = true; // ~1.2s to go: the chirp
      this.emit({ type: "chaos", kind: "inspiral", x: bn.cx, y: bn.cy });
    }
    if (bn.r > 8) return;
    this.binary = null;
    // the gravitational wave shoves every ball outward...
    for (const b of this.balls) {
      if (b.stuck) continue;
      const dx = b.x - bn.cx;
      const dy = b.y - bn.cy;
      const d = Math.hypot(dx, dy) || 1;
      const s = Math.min(this.rules.maxSpeed, Math.hypot(b.vx, b.vy) * 1.12);
      b.vx += (dx / d) * 4;
      b.vy += (dy / d) * 4;
      const ns = Math.hypot(b.vx, b.vy) || 1;
      b.vx *= s / ns;
      b.vy *= s / ns;
      if (Math.abs(b.vx) < s * 0.4) {
        const vx = Math.sign(b.vx || 1) * s * 0.4;
        b.vy = Math.sign(b.vy || 1) * Math.sqrt(Math.max(0, s * s - vx * vx));
        b.vx = vx;
      }
    }
    // ...and what is left is one hole, already collapsing: SUPERNOVA next
    this.well = { x: bn.cx, y: bn.cy, ticks: COLLAPSE_TICKS, phase: "collapse" };
    this.hitstopTicks = 8;
    this.emit({ type: "chaos", kind: "merger", x: bn.cx, y: bn.cy });
  }

  private openWormhole(): void {
    this.portals = null;
    const leftIn = this.rng() < 0.5;
    this.wormhole = {
      a: { x: leftIn ? 450 : 830, y: 160 + this.rng() * 400 },
      b: { x: leftIn ? 830 : 450, y: 160 + this.rng() * 400 },
      ticks: 600,
    };
  }

  private openPrism(): void {
    this.prism = { x: FIELD.W / 2, y: 200 + this.rng() * 320, ticks: 720 };
  }

  /**
   * PRISM: white light in, a rainbow out. Three rays, and - dispersion - each
   * colour travels at its own speed, so they fan out and arrive one by one.
   */
  private disperse(b: SimBall, x: number, y: number): void {
    const speed = Math.hypot(b.vx, b.vy);
    const base = Math.atan2(b.vy, b.vx);
    const rays = [
      { off: -0.26, k: 0.86, hue: 0xff4d6d },
      { off: 0, k: 1, hue: 0x3dff8a },
      { off: 0.26, k: 1.16, hue: 0x8a7dff },
    ];
    const dir = Math.sign(b.vx || 1);
    for (const r of rays) {
      const target = r.off === 0 ? b : this.newBall(b.x, b.y, 0, 0);
      const s = Math.min(this.rules.maxSpeed, speed * r.k);
      let vx = Math.cos(base + r.off) * s;
      let vy = Math.sin(base + r.off) * s;
      if (Math.sign(vx) !== dir || Math.abs(vx) < s * 0.42) {
        vx = dir * s * 0.42;
        vy = Math.sign(vy || 1) * Math.sqrt(Math.max(0, s * s - vx * vx));
      }
      target.vx = vx;
      target.vy = vy;
      target.hue = r.hue;
      if (target !== b) {
        target.lastHit = b.lastHit;
        target.warpCd = 8;
        this.balls.push(target);
      }
    }
    this.emit({ type: "chaos", kind: "prism", x, y, count: this.balls.length });
  }

  /** QUANTUM: the ball becomes three possible balls. Only one is real. */
  private superpose(b: SimBall): void {
    const group = this.nextId++;
    const speed = Math.hypot(b.vx, b.vy);
    const base = Math.atan2(b.vy, b.vx);
    const dir = Math.sign(b.vx || 1);
    b.phantom = group;
    for (const off of [-0.36, 0.36]) {
      let vx = Math.cos(base + off) * speed;
      let vy = Math.sin(base + off) * speed;
      if (Math.sign(vx) !== dir || Math.abs(vx) < speed * 0.42) {
        vx = dir * speed * 0.42;
        vy = Math.sign(vy || 1) * Math.sqrt(Math.max(0, speed * speed - vx * vx));
      }
      const nb = this.newBall(b.x, b.y, vx, vy);
      nb.lastHit = b.lastHit;
      nb.phantom = group;
      nb.spin = b.spin;
      this.balls.push(nb);
    }
    this.qGroups.set(group, 0);
    this.emit({ type: "chaos", kind: "quantum", x: b.x, y: b.y });
  }

  /** Observation: a superposition that nears a paddle collapses to one ball. */
  private tickQuantum(): void {
    for (const [g, t] of [...this.qGroups]) {
      const branches = this.balls.filter((b) => b.phantom === g);
      if (!branches.length) { this.qGroups.delete(g); continue; }
      const observed = t + 1 >= OBSERVE.ticks || branches.some((b) => b.x < OBSERVE.left || b.x > OBSERVE.right);
      if (!observed) { this.qGroups.set(g, t + 1); continue; }
      const keep = branches[Math.floor(this.rng() * branches.length)];
      const gone = branches.filter((b) => b !== keep);
      keep.phantom = 0;
      this.balls = this.balls.filter((b) => !gone.includes(b));
      this.qGroups.delete(g);
      this.emit({ type: "chaos", kind: "quantum_collapse", x: keep.x, y: keep.y, gone: gone.map((b) => ({ x: b.x, y: b.y })) });
    }
  }

  private openOrrery(): void {
    const a0 = this.rng() * Math.PI * 2;
    const dir = this.rng() < 0.5 ? -1 : 1;
    this.bumpers = [0, 1, 2, 3].map((i) => {
      const inner = i % 2 === 1;
      const orbit = { cx: FIELD.W / 2, cy: FIELD.H / 2, r: inner ? 120 : 210, a: a0 + (i / 4) * Math.PI * 2, w: dir * (inner ? 0.016 : 0.011) };
      return { id: this.nextId++, x: orbit.cx + Math.cos(orbit.a) * orbit.r, y: orbit.cy + Math.sin(orbit.a) * orbit.r * 0.78, r: inner ? 26 : 32, orbit };
    });
    this.bumperTicks = 660;
  }

  /** The cage's two beams, as segments. */
  cageBeams(): { a: { x: number; y: number }; b: { x: number; y: number } }[] {
    const c = this.cage;
    if (!c) return [];
    return [c.angle, c.angle + Math.PI / 2].map((t) => {
      const ux = Math.cos(t) * c.len;
      const uy = Math.sin(t) * c.len;
      return { a: { x: c.cx - ux, y: c.cy - uy }, b: { x: c.cx + ux, y: c.cy + uy } };
    });
  }

  /** Did the ball cross a beam this tick? The beams turn, so compare the
   *  ball's side of each beam at the old angle with the new. */
  private crossesCage(px: number, py: number, x: number, y: number, scale = 1): boolean {
    const c = this.cage!;
    for (const t of [c.angle, c.angle + Math.PI / 2]) {
      const t0 = t - c.w * scale; // how far the beam turned THIS tick (slow-mo turns it less)
      const side0 = -Math.sin(t0) * (px - c.cx) + Math.cos(t0) * (py - c.cy);
      const side1 = -Math.sin(t) * (x - c.cx) + Math.cos(t) * (y - c.cy);
      const along = Math.cos(t) * (x - c.cx) + Math.sin(t) * (y - c.cy);
      if (side0 !== 0 && Math.sign(side0) !== Math.sign(side1) && Math.abs(along) < c.len) return true;
    }
    return false;
  }

  private electrify(b: SimBall): void {
    const s = Math.min(this.rules.maxSpeed, Math.hypot(b.vx, b.vy) * 1.22);
    const vy = (this.rng() < 0.5 ? -1 : 1) * (5 + this.rng() * 6);
    b.vy = vy;
    b.vx = Math.sign(b.vx || 1) * Math.sqrt(Math.max(16, s * s - vy * vy));
    b.warpCd = 10;
    this.emit({ type: "chaos", kind: "zap", x: b.x, y: b.y, side: b.lastHit });
  }

  // -------------------------------------------------------------- queries
  /** The ball that will reach `side` soonest, if any is heading there. */
  nearestIncoming(side: Side): SimBall | null {
    let best: SimBall | null = null;
    let bestT = Infinity;
    for (const b of this.balls) {
      if (b.stuck) continue;
      const toward = side === "left" ? b.vx < 0 : b.vx > 0;
      if (!toward) continue;
      const face = side === "left" ? L_FACE : R_FACE;
      const t = Math.abs((b.x - face) / (b.vx || 1));
      if (t < bestT) { bestT = t; best = b; }
    }
    return best;
  }

  private emit(e: SimEvent): void {
    this.events.push(e);
  }

  // ------------------------------------------------------------- snapshot
  snapshot() {
    const primary = this.balls[0];
    const scale = this.timeScale;
    return {
      ballX: primary ? primary.x : this.parked.x,
      ballY: primary ? primary.y : this.parked.y,
      ballVelocityX: primary ? primary.vx : 0,
      ballVelocityY: primary ? primary.vy : 0,
      ballSpin: primary ? primary.spin : 0,
      paddle1Y: this.paddles.left.y,
      paddle2Y: this.paddles.right.y,
      paddle1Height: this.paddleHeight("left"),
      paddle2Height: this.paddleHeight("right"),
      score1: this.score.left,
      score2: this.score.right,
      gameStarted: true,
      timeScale: scale,
      hold: this.held,
      heightsAuthoritative: true,
      targets: this.rules.targets ? this.targets.map((t) => ({ id: t.id, x: t.x, y: t.y, r: t.r, kind: t.kind })) : undefined,
      timeLeft: this.rules.timeLimit ? Math.max(0, (this.rules.timeLimit - this.playTicks) / 60) : undefined,
      balls: this.balls.map((b) => ({ id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, spin: b.spin, fire: b.fire, ghostFor: b.ghostFor, stuck: !!b.stuck, hue: b.hue, plasma: b.plasma, phantom: b.phantom, golden: !!b.golden })),
      orbs: this.orbs.map((o) => ({ ...o })),
      portals: this.portals ? { ...this.portals } : null,
      well: this.well ? { ...this.well } : null,
      bumpers: this.bumpers.map((b) => ({ ...b })),
      tesla: this.tesla ? { ...this.tesla } : null,
      gravity: this.gravity ? this.gravity.g : 0,
      gravityFlips: !!this.gravity?.flipEvery,
      binary: this.binary ? { holes: this.binaryHoles()!, r: this.binary.r, cx: this.binary.cx, cy: this.binary.cy } : null,
      wormhole: this.wormhole ? { a: { ...this.wormhole.a }, b: { ...this.wormhole.b }, ticks: this.wormhole.ticks } : null,
      prism: this.prism ? { ...this.prism } : null,
      cage: this.cage ? { cx: this.cage.cx, cy: this.cage.cy, beams: this.cageBeams(), ticks: this.cage.ticks } : null,
      warpDrive: this.hyperTicks > 0 ? (this.hyperScale > 1.45 ? "lightspeed" : "hyper") : null,
      finale: this.finaleTicks > 0,
      suddenDeath: this.suddenDeath,
      clones: { left: this.cloneY("left"), right: this.cloneY("right") },
      mods: {
        left: { mega: this.paddles.left.megaTicks > 0, shrink: this.paddles.left.shrinkTicks > 0, magnet: this.paddles.left.magnet, power: this.paddles.left.power },
        right: { mega: this.paddles.right.megaTicks > 0, shrink: this.paddles.right.shrinkTicks > 0, magnet: this.paddles.right.magnet, power: this.paddles.right.power },
      },
    };
  }
}

export type SimSnapshot = ReturnType<PongSim["snapshot"]>;

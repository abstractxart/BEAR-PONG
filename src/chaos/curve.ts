// MIRRORED from BEAR-PONG/src/sim/curve.ts by scripts/sync-sim.mjs - do not edit here.
/**
 * BEAR CURVE - swing the paddle hard through the ball and it bends.
 *
 * Pure maths shared by the local simulation (Chaos Lab, demo) and, on the
 * server branch, by the online game, so the curve is identical everywhere.
 *
 *   swing -> spin   The paddle's vertical speed at the moment of contact
 *                   (px per 60Hz tick). Below SWING_MIN nothing happens - a
 *                   normal return is a normal return. Above it, spin grows
 *                   with swing speed up to a cap.
 *
 *   spin  -> curve  Every tick the velocity vector ROTATES by `spin` radians,
 *                   toward the direction of the swing. Rotating, not pushing:
 *                   speed is preserved exactly, so a curve never secretly
 *                   speeds up or slows the rally - it only bends it. Spin
 *                   decays each tick, so the bend is strongest off the paddle
 *                   and straightens out across the court, which is what makes
 *                   it readable rather than random.
 *
 * With the classic cap a maximal swing bends a cross-court ball by ~22
 * degrees; the Chaos Lab cap allows ~37 ("banana shot").
 *
 *   the break       (lab) A bent bullet does not curl off the barrel - it
 *                   flies true for a beat and THEN bends. With `breakIn`
 *                   the bend fades in over that many ticks after contact,
 *                   and the spin holds (no decay) until it has, so the ball
 *                   leaves the paddle straight and breaks hard mid-court.
 *
 * PHYSICS v3 - the contact and the walls behave like a real ball:
 *
 *   english         The face is not frictionless. Whatever the paddle is
 *                   doing at contact drags the ball with it: a fraction of
 *                   its vertical speed goes into the return's angle. Even a
 *                   gentle push aims the ball - you steer with your swing.
 *
 *   the kick        A spinning ball does not bounce like a dead one. Bend
 *                   INTO a wall (topspin, relative to that wall) and it skids
 *                   off faster along it; bend AWAY (backspin) and it checks
 *                   up. The spin is the rule, so it is readable - the sight
 *                   and the tracer draw the kick.
 *
 *   BULLSEYE        Dead centre (|hit| <= 0.05, about 3px on a full paddle):
 *                   one more speed-up on top of a PERFECT.
 */

export interface CurveRules {
  /** paddle speed (px/tick) a swing has to beat before it adds spin */
  swingMin: number;
  /** spin added per px/tick of swing above swingMin */
  spinPerSwing: number;
  /** most spin a single swing can add (rad/tick) */
  spinMax: number;
  /** per-tick spin retention */
  decay: number;
  /** spin kept after a wall bounce */
  wallKeep: number;
  /** a curve may never turn the ball more vertical than this |vx|/speed */
  minHorizontal: number;
  /** ticks after contact for the bend to come fully on (0/absent: at once) */
  breakIn?: number;
  /** ENGLISH: fraction of the paddle's px/tick at contact added to the return's vy */
  english?: number;
  /** the most vy english can add (px/tick) */
  englishMax?: number;
  /** THE KICK: at full spin a wall bounce speeds |vx| up (topspin) or checks it (backspin) by this fraction */
  kick?: number;
}

/** Dead centre: |hit position| at or under this is a BULLSEYE (a PERFECT and one more speed-up). */
export const BULLSEYE = 0.05;

export const CLASSIC_CURVE: CurveRules = {
  swingMin: 7,
  spinPerSwing: 0.0011,
  spinMax: 0.012,
  decay: 0.985,
  wallKeep: 0.5,
  minHorizontal: 0.5,
};

/**
 * Ranked (server protocol 2): the classic curve with the bullet break.
 * KEEP IN STEP with the server's src/curve.ts (abstractxart/BEAR-PONG).
 */
export const RANKED_CURVE: CurveRules = { ...CLASSIC_CURVE, breakIn: 10, english: 0.14, englishMax: 2.2, kick: 0.16 };

export const CHAOS_CURVE: CurveRules = {
  swingMin: 6,
  spinPerSwing: 0.0016,
  spinMax: 0.02,
  decay: 0.986,
  wallKeep: 0.55,
  minHorizontal: 0.42,
  breakIn: 12,
  english: 0.2,
  englishMax: 3.4,
  kick: 0.24,
};

/** Spin imparted by a swing (signed: negative = swung up, curves up). */
export function spinFromSwing(paddleVy: number, rules: CurveRules = CLASSIC_CURVE): number {
  if (!Number.isFinite(paddleVy)) return 0;
  const over = Math.abs(paddleVy) - rules.swingMin;
  if (over <= 0) return 0;
  return Math.sign(paddleVy) * Math.min(rules.spinMax, over * rules.spinPerSwing);
}

/** ENGLISH: the vy a paddle moving at `paddleVy` px/tick drags into the return. */
export function englishFor(paddleVy: number, rules: CurveRules | null): number {
  const e = rules?.english ?? 0;
  if (!e || !Number.isFinite(paddleVy)) return 0;
  const m = rules!.englishMax ?? Infinity;
  return Math.max(-m, Math.min(m, paddleVy * e));
}

/**
 * A wall bounce, with THE KICK. `wall` is 1 for the bottom wall (y grows
 * toward it), -1 for the top. Flips vy, applies the kick to vx (never past
 * `maxSpeed`, never steeper than the curve's minHorizontal), and returns the
 * spin to carry on and the kick applied (+ skid, - check, 0 none).
 */
export function wallBounce(v: { vx: number; vy: number }, spin: number, rules: CurveRules | null, wall: 1 | -1, maxSpeed = Infinity): { spin: number; kick: number } {
  v.vy = -wall * Math.abs(v.vy);
  if (!rules || !spin) return { spin: 0, kick: 0 };
  let kick = 0;
  if (rules.kick) {
    const k = rules.kick * Math.min(1, Math.abs(spin) / rules.spinMax);
    // positive spin bends toward +y (the bottom wall): into the wall it skids, away it checks
    kick = Math.sign(spin) === wall ? k : -k * 0.7;
    const speed = Math.hypot(v.vx, v.vy);
    let vx = v.vx * (1 + kick);
    const cap = Math.sqrt(Math.max(0, maxSpeed * maxSpeed - v.vy * v.vy));
    if (Math.abs(vx) > cap) vx = Math.sign(vx) * cap;
    const floor = rules.minHorizontal * speed * 0.9;
    if (Math.abs(vx) < floor) vx = Math.sign(vx) * floor;
    kick = v.vx ? vx / v.vx - 1 : 0;
    v.vx = vx;
  }
  return { spin: spin * rules.wallKeep, kick };
}

/** 0..1 - how close a swing is to maximum curve (drives the paddle glow). */
export function swingCharge(paddleVy: number, rules: CurveRules = CLASSIC_CURVE): number {
  return Math.min(1, Math.abs(spinFromSwing(paddleVy, rules)) / rules.spinMax);
}

/**
 * Advance one tick of curve. Mutates and returns the velocity; returns the
 * spin to carry into the next tick.
 */
export function applyCurve(v: { vx: number; vy: number }, spin: number, rules: CurveRules = CLASSIC_CURVE, scale = 1, age = Infinity): number {
  if (!spin || !v.vx) return 0;
  const speed = Math.hypot(v.vx, v.vy);
  if (speed < 0.001) return 0;
  const breakIn = rules.breakIn ?? 0;
  const ramp = breakIn > 0 ? Math.min(1, (age + 1) / breakIn) : 1;
  // Rotating by +w turns (vx, vy) so that vy changes by ~vx*w; multiplying by
  // sign(vx) makes the bend follow the swing whichever way the ball travels.
  const w = spin * ramp * Math.sign(v.vx) * scale;
  const c = Math.cos(w);
  const s = Math.sin(w);
  const nvx = v.vx * c - v.vy * s;
  const nvy = v.vx * s + v.vy * c;
  if (Math.abs(nvx) / speed < rules.minHorizontal || Math.sign(nvx) !== Math.sign(v.vx)) return 0; // would stall: stop curving
  v.vx = nvx;
  v.vy = nvy;
  return ramp < 1 ? spin : spin * Math.pow(rules.decay, scale); // the spin holds until the break is in
}

/**
 * Where a struck ball will travel, bend included (walls, spin, the break) -
 * for drawing the tracer. Ignores wells, gravity and the rest of the lab.
 */
export function curvePath(
  b: { x: number; y: number; vx: number; vy: number },
  spin: number,
  rules: CurveRules,
  bounds: { top: number; bottom: number; left: number; right: number },
  ticks = 90,
  maxSpeed = Infinity
): { x: number; y: number }[] {
  const v = { vx: b.vx, vy: b.vy };
  let { x, y } = b;
  let s = spin;
  const out = [{ x, y }];
  for (let t = 0; t < ticks; t++) {
    if (s) s = applyCurve(v, s, rules, 1, t);
    x += v.vx;
    y += v.vy;
    if (y < bounds.top) { y = 2 * bounds.top - y; s = wallBounce(v, s, rules, -1, maxSpeed).spin; }
    else if (y > bounds.bottom) { y = 2 * bounds.bottom - y; s = wallBounce(v, s, rules, 1, maxSpeed).spin; }
    out.push({ x, y });
    if (x < bounds.left || x > bounds.right) break;
  }
  return out;
}

/** Total bend (radians) a given spin will produce before it decays away. */
export function totalBend(spin: number, rules: CurveRules = CLASSIC_CURVE, ticks = 44): number {
  return Math.abs(spin) * (1 - Math.pow(rules.decay, ticks)) / (1 - rules.decay);
}

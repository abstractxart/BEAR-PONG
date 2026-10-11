/**
 * BEAR CURVE - swing the paddle hard through the ball and it bends.
 *
 * KEEP IN STEP with the client's src/sim/curve.ts (BEAR-PONG repo): the
 * client draws the curve's tracer and predicts the bend with the same maths,
 * so the two must agree to the decimal.
 *
 *   swing -> spin   the paddle's vertical speed at contact, px per 60Hz tick.
 *                   Below swingMin nothing happens; above it spin grows with
 *                   swing speed, up to a cap.
 *   spin  -> curve  every tick the velocity ROTATES by spin radians toward
 *                   the swing - speed is preserved exactly.
 *   the break       the bend fades in over `breakIn` ticks after contact (the
 *                   spin holds until it has), so the ball leaves the paddle
 *                   straight and breaks mid-court, like a bent bullet.
 *
 * PHYSICS v3:
 *   english         the face drags the ball: a fraction of the paddle's
 *                   px/tick at contact goes into the return's vy (capped)
 *   the kick        a spinning ball bending INTO a wall skids off faster
 *                   along it; bending AWAY it checks up
 *   BULLSEYE        |hit| <= 0.05: one more speed-up on top of a PERFECT
 */
export interface CurveRules {
  swingMin: number;
  spinPerSwing: number;
  spinMax: number;
  decay: number;
  wallKeep: number;
  minHorizontal: number;
  breakIn?: number;
  english?: number;
  englishMax?: number;
  kick?: number;
}

/** Dead centre: |hit position| at or under this is a BULLSEYE. */
export const BULLSEYE = 0.05;

/** Ranked: a real but restrained curve (~22 degrees at a maximal swing). */
export const RANKED_CURVE: CurveRules = {
  swingMin: 7,
  spinPerSwing: 0.0011,
  spinMax: 0.012,
  decay: 0.985,
  wallKeep: 0.5,
  minHorizontal: 0.5,
  breakIn: 10,
  english: 0.14,
  englishMax: 2.2,
  kick: 0.16,
};

/** ENGLISH: the vy a paddle moving at `paddleVy` px/tick drags into the return. */
export function englishFor(paddleVy: number, rules: CurveRules | null = RANKED_CURVE): number {
  const e = rules?.english ?? 0;
  if (!e || !Number.isFinite(paddleVy)) return 0;
  const m = rules!.englishMax ?? Infinity;
  return Math.max(-m, Math.min(m, paddleVy * e));
}

/**
 * A wall bounce with THE KICK. `wall` 1 = bottom, -1 = top. Flips vy, kicks
 * vx (never past maxSpeed, never steeper than minHorizontal); returns the
 * spin to carry on and the kick applied (+ skid, - check).
 */
export function wallBounce(v: { vx: number; vy: number }, spin: number, rules: CurveRules | null, wall: 1 | -1, maxSpeed = Infinity): { spin: number; kick: number } {
  v.vy = -wall * Math.abs(v.vy);
  if (!rules || !spin) return { spin: 0, kick: 0 };
  let kick = 0;
  if (rules.kick) {
    const k = rules.kick * Math.min(1, Math.abs(spin) / rules.spinMax);
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

/** Spin imparted by a swing (signed: negative = swung up, curves up). */
export function spinFromSwing(paddleVy: number, rules: CurveRules = RANKED_CURVE): number {
  if (!Number.isFinite(paddleVy)) return 0;
  const over = Math.abs(paddleVy) - rules.swingMin;
  if (over <= 0) return 0;
  return Math.sign(paddleVy) * Math.min(rules.spinMax, over * rules.spinPerSwing);
}

/** Advance one tick of curve; mutates `v`, returns the spin for next tick. */
export function applyCurve(v: { vx: number; vy: number }, spin: number, rules: CurveRules = RANKED_CURVE, scale = 1, age = Infinity): number {
  if (!spin || !v.vx) return 0;
  const speed = Math.hypot(v.vx, v.vy);
  if (speed < 0.001) return 0;
  const breakIn = rules.breakIn ?? 0;
  const ramp = breakIn > 0 ? Math.min(1, (age + 1) / breakIn) : 1;
  const w = spin * ramp * Math.sign(v.vx) * scale;
  const c = Math.cos(w);
  const s = Math.sin(w);
  const nvx = v.vx * c - v.vy * s;
  const nvy = v.vx * s + v.vy * c;
  if (Math.abs(nvx) / speed < rules.minHorizontal || Math.sign(nvx) !== Math.sign(v.vx)) return 0;
  v.vx = nvx;
  v.vy = nvy;
  return ramp < 1 ? spin : spin * Math.pow(rules.decay, scale);
}

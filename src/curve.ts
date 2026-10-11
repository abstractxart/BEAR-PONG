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
 */
export interface CurveRules {
  swingMin: number;
  spinPerSwing: number;
  spinMax: number;
  decay: number;
  wallKeep: number;
  minHorizontal: number;
  breakIn?: number;
}

/** Ranked: a real but restrained curve (~22 degrees at a maximal swing). */
export const RANKED_CURVE: CurveRules = {
  swingMin: 7,
  spinPerSwing: 0.0011,
  spinMax: 0.012,
  decay: 0.985,
  wallKeep: 0.5,
  minHorizontal: 0.5,
  breakIn: 10,
};

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

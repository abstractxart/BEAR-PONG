/** The court, as the client's src/config.ts has it (the mirrored sim needs only this). */
export const FIELD = {
  W: 1280,
  H: 720,
  PADDLE_W: 20,
  PADDLE_H: 120,
  /** distance from the field edge to the paddle's outer face */
  PADDLE_INSET: 50,
  BALL: 20,
  WALL: 8,
  WIN_SCORE: 3,
} as const;

export type Side = "left" | "right";

/**
 * Shared type definitions for Pong multiplayer
 * These types are used by both server and client
 */

// Player data structure
export interface PlayerData {
  wallet: string;
  displayName: string;
  avatarUrl?: string;
}

// Game state sent from server to clients
export interface GameState {
  ballX: number;
  ballY: number;
  ballVelocityX: number;
  ballVelocityY: number;
  paddle1Y: number;
  paddle2Y: number;
  score1: number;
  score2: number;
  gameStarted: boolean;
  countdown?: number; // 3, 2, 1, null
}

// Client -> Server messages
export type ClientMessage =
  | { type: 'join_queue'; data: PlayerData }
  | { type: 'paddle_move'; y: number; timestamp: number }
  | { type: 'ready' }
  | { type: 'rematch' }
  | { type: 'leave' };

// Server -> Client messages
export type ServerMessage =
  | { type: 'queue_joined'; position: number }
  | { type: 'match_found'; opponent: PlayerData; yourSide: 'left' | 'right' }
  | { type: 'countdown'; count: number }
  | { type: 'game_state'; state: GameState }
  | { type: 'game_over'; winner: 'left' | 'right'; finalScore: { left: number; right: number } }
  | { type: 'opponent_disconnected' }
  | { type: 'rematch_requested' }
  | { type: 'rematch_accepted' }
  | { type: 'error'; message: string };

// Game constants
export const GAME_CONFIG = {
  CANVAS_WIDTH: 1280,
  CANVAS_HEIGHT: 720,
  PADDLE_WIDTH: 20,
  PADDLE_HEIGHT: 120,
  BALL_SIZE: 20,
  PADDLE_SPEED: 10,
  INITIAL_BALL_SPEED: 6,
  BALL_SPEED_INCREMENT: 0.3,
  MAX_BALL_SPEED: 15,
  WINNING_SCORE: 3,
  TICK_RATE: 60, // Server updates per second
  COUNTDOWN_DURATION: 3,
};

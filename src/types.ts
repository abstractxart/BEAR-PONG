/**
 * Shared type definitions for Pong multiplayer
 * These types are used by both server and client
 */

// Cosmetic data structure
export interface CosmeticData {
  id: number;
  name: string;
  image_url: string;
  is_animated?: boolean;
  css_gradient?: string;
}

// Equipped cosmetics
export interface EquippedCosmetics {
  ring: CosmeticData | null;
  banner: CosmeticData | null;
}

// Player data structure
export interface PlayerData {
  wallet: string;
  displayName: string;
  avatarUrl?: string;
  equippedCosmetics?: EquippedCosmetics;
  /** client protocol version (2 = speaks ping/pong, paddle_hit, hold, ballSpin) */
  protocol?: number;
}

/** This server's protocol version, announced in match_found. */
export const SERVER_PROTOCOL = 2;

// Game state sent from server to clients
export interface GameState {
  ballX: number;
  ballY: number;
  ballVelocityX: number;
  ballVelocityY: number;
  paddle1Y: number;
  paddle2Y: number;
  paddle1Height: number;  // 🔥 Added for progressive paddle shrinking
  paddle2Height: number;  // 🔥 Added for progressive paddle shrinking
  score1: number;
  score2: number;
  gameStarted: boolean;
  countdown?: number; // 3, 2, 1, null
  /** BEAR CURVE: the ball's spin (rad/tick, signed) */
  ballSpin?: number;
  /** the ball is held at a paddle face: hit-stop, or awaiting a late paddle */
  hold?: boolean;
  /** THE SQUEEZE: the reported paddle heights are the real hitboxes */
  squeeze?: boolean;
}

// Ultimate ability types
export type UltimateAbilityType = 'time_freeze' | 'paddle_dash' | 'power_hit';

// Client -> Server messages
export type ClientMessage =
  | { type: 'join_queue'; data: PlayerData }
  | { type: 'paddle_move'; y: number; timestamp: number }
  | { type: 'set_bet'; amount: number }
  | { type: 'ready_to_start' }
  | { type: 'ready' }
  | { type: 'use_ultimate'; abilityType: UltimateAbilityType }
  | { type: 'rematch' }
  | { type: 'leave' }
  | { type: 'pong'; t: number };

// Server -> Client messages
export type ServerMessage =
  | { type: 'queue_joined'; position: number }
  | { type: 'match_found'; opponent: PlayerData; yourSide: 'left' | 'right'; serverVersion?: number }
  | { type: 'ping'; t: number }
  | { type: 'paddle_hit'; side: 'left' | 'right'; hitPosition: number; perfect: boolean; bullseye: boolean; edge: boolean; power: boolean; spin: number; x: number; y: number; late: number }
  | { type: 'opponent_bet_set'; amount: number }
  | { type: 'opponent_ready' }
  | { type: 'final_bet_amount'; amount: number }
  | { type: 'betting_timeout' }
  | { type: 'countdown'; count: number }
  | { type: 'game_state'; state: GameState }
  | { type: 'ultimate_activated'; side: 'left' | 'right'; abilityType: UltimateAbilityType }
  | { type: 'powerups_refreshed' }
  | { type: 'edge_hit'; side: 'left' | 'right'; hitPosition: number }
  | { type: 'game_over'; winner: 'left' | 'right'; finalScore: { left: number; right: number }; betAmount: number }
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
  MIN_PADDLE_HEIGHT: 66,  // THE SQUEEZE bottoms out at 55% of the full paddle
  BALL_SIZE: 20,
  PADDLE_SPEED: 13,  // 🚀 Increased from 10 for faster paddle response
  PADDLE_MAX_VELOCITY: 45,  // 🚀 Increased from 35 for snappier movement
  INITIAL_BALL_SPEED: 8,  // 🚀 Increased from 6 for faster-paced gameplay
  BALL_SPEED_INCREMENT: 0.035,  // 🔥 3.5% speed increase per hit - Smoother escalation (35 hits to max)
  MAX_BALL_SPEED: 27,  // 🚀 Reduced from 35 to 27 for better playability
  PADDLE_SHRINK_PER_HIT: 2.5,  // THE SQUEEZE: every return costs both paddles 2.5px, until the point ends
  WINNING_SCORE: 3,
  TICK_RATE: 60, // Server updates per second
  COUNTDOWN_DURATION: 3,
};

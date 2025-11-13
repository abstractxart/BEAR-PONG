/**
 * GameSession - Handles the physics and state for a single Pong match
 */
import { GAME_CONFIG, GameState, PlayerData } from './types.js';
import type { WebSocket } from 'ws';

export class GameSession {
  private gameState: GameState;
  private player1: { ws: WebSocket; data: PlayerData };
  private player2: { ws: WebSocket; data: PlayerData };
  private gameLoop: NodeJS.Timeout | null = null;
  private countdown: number = GAME_CONFIG.COUNTDOWN_DURATION;
  private countdownInterval: NodeJS.Timeout | null = null;

  // Track previous ball position for continuous collision detection
  private prevBallX: number = 0;
  private prevBallY: number = 0;

  constructor(
    player1: { ws: WebSocket; data: PlayerData },
    player2: { ws: WebSocket; data: PlayerData }
  ) {
    this.player1 = player1;
    this.player2 = player2;

    // Initialize game state
    this.gameState = {
      ballX: GAME_CONFIG.CANVAS_WIDTH / 2,
      ballY: GAME_CONFIG.CANVAS_HEIGHT / 2,
      ballVelocityX: GAME_CONFIG.INITIAL_BALL_SPEED * (Math.random() > 0.5 ? 1 : -1),
      ballVelocityY: GAME_CONFIG.INITIAL_BALL_SPEED * (Math.random() * 2 - 1),
      paddle1Y: GAME_CONFIG.CANVAS_HEIGHT / 2, // Center Y (matches client Phaser Container positioning)
      paddle2Y: GAME_CONFIG.CANVAS_HEIGHT / 2, // Center Y (matches client Phaser Container positioning)
      score1: 0,
      score2: 0,
      gameStarted: false,
      countdown: GAME_CONFIG.COUNTDOWN_DURATION,
    };
  }

  /**
   * Start the countdown and then the game
   */
  start() {
    console.log('🎮 Starting countdown for match');

    this.countdownInterval = setInterval(() => {
      this.countdown--;
      this.gameState.countdown = this.countdown;

      // Send countdown to both players
      this.sendToPlayer(this.player1.ws, {
        type: 'countdown',
        count: this.countdown,
      });
      this.sendToPlayer(this.player2.ws, {
        type: 'countdown',
        count: this.countdown,
      });

      if (this.countdown <= 0) {
        this.startGame();
      }
    }, 1000);
  }

  /**
   * Start the actual game loop
   */
  private startGame() {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }

    this.gameState.gameStarted = true;
    this.gameState.countdown = undefined;

    console.log('🎮 Game started!');

    // Start game loop at 60 FPS
    this.gameLoop = setInterval(() => {
      this.updatePhysics();
      this.broadcastGameState();
    }, 1000 / GAME_CONFIG.TICK_RATE);
  }

  /**
   * Update game physics (ball movement, collision detection)
   * Uses swept collision detection to prevent tunneling
   */
  private updatePhysics() {
    if (!this.gameState.gameStarted) return;

    // Store previous position for swept collision
    this.prevBallX = this.gameState.ballX;
    this.prevBallY = this.gameState.ballY;

    // Move ball
    this.gameState.ballX += this.gameState.ballVelocityX;
    this.gameState.ballY += this.gameState.ballVelocityY;

    // Ball collision with top/bottom walls (bounce off)
    if (
      this.gameState.ballY <= GAME_CONFIG.BALL_SIZE / 2 ||
      this.gameState.ballY >= GAME_CONFIG.CANVAS_HEIGHT - GAME_CONFIG.BALL_SIZE / 2
    ) {
      this.gameState.ballVelocityY *= -1;
      this.gameState.ballY = Math.max(
        GAME_CONFIG.BALL_SIZE / 2,
        Math.min(GAME_CONFIG.CANVAS_HEIGHT - GAME_CONFIG.BALL_SIZE / 2, this.gameState.ballY)
      );
    }

    // SWEPT COLLISION DETECTION for paddles (prevents tunneling)
    // Left paddle (player 1) - positioned at left edge
    const paddle1Left = 50;
    const paddle1Right = paddle1Left + GAME_CONFIG.PADDLE_WIDTH;
    // paddle1Y is the CENTER of the paddle (matches client-side Phaser Container positioning)
    const paddle1Top = this.gameState.paddle1Y - GAME_CONFIG.PADDLE_HEIGHT / 2;
    const paddle1Bottom = this.gameState.paddle1Y + GAME_CONFIG.PADDLE_HEIGHT / 2;

    // Check if ball crossed the paddle's X boundary
    if (
      this.gameState.ballVelocityX < 0 && // Moving left
      this.prevBallX - GAME_CONFIG.BALL_SIZE / 2 > paddle1Right && // Was to the right
      this.gameState.ballX - GAME_CONFIG.BALL_SIZE / 2 <= paddle1Right // Now at or past paddle
    ) {
      // Calculate Y position when ball crosses paddle's X
      const t = (paddle1Right - (this.prevBallX - GAME_CONFIG.BALL_SIZE / 2)) / this.gameState.ballVelocityX;
      const crossY = this.prevBallY + (this.gameState.ballVelocityY * t);

      // Check if Y position is within paddle bounds
      if (crossY >= paddle1Top - GAME_CONFIG.BALL_SIZE / 2 && crossY <= paddle1Bottom + GAME_CONFIG.BALL_SIZE / 2) {
        // HIT! Reflect the ball
        this.gameState.ballVelocityX = Math.abs(this.gameState.ballVelocityX);
        this.gameState.ballX = paddle1Right + GAME_CONFIG.BALL_SIZE / 2;

        // Add spin based on where ball hit paddle
        const paddleCenter = (paddle1Top + paddle1Bottom) / 2;
        const hitPosition = (crossY - paddleCenter) / (GAME_CONFIG.PADDLE_HEIGHT / 2);
        this.gameState.ballVelocityY += hitPosition * 3;

        // Increase ball speed slightly
        this.speedUpBall();
      }
    }

    // Right paddle (player 2) - positioned at right edge
    const paddle2Left = GAME_CONFIG.CANVAS_WIDTH - 50 - GAME_CONFIG.PADDLE_WIDTH;
    const paddle2Right = paddle2Left + GAME_CONFIG.PADDLE_WIDTH;
    // paddle2Y is the CENTER of the paddle (matches client-side Phaser Container positioning)
    const paddle2Top = this.gameState.paddle2Y - GAME_CONFIG.PADDLE_HEIGHT / 2;
    const paddle2Bottom = this.gameState.paddle2Y + GAME_CONFIG.PADDLE_HEIGHT / 2;

    // Check if ball crossed the paddle's X boundary
    if (
      this.gameState.ballVelocityX > 0 && // Moving right
      this.prevBallX + GAME_CONFIG.BALL_SIZE / 2 < paddle2Left && // Was to the left
      this.gameState.ballX + GAME_CONFIG.BALL_SIZE / 2 >= paddle2Left // Now at or past paddle
    ) {
      // Calculate Y position when ball crosses paddle's X
      const t = (paddle2Left - (this.prevBallX + GAME_CONFIG.BALL_SIZE / 2)) / this.gameState.ballVelocityX;
      const crossY = this.prevBallY + (this.gameState.ballVelocityY * t);

      // Check if Y position is within paddle bounds
      if (crossY >= paddle2Top - GAME_CONFIG.BALL_SIZE / 2 && crossY <= paddle2Bottom + GAME_CONFIG.BALL_SIZE / 2) {
        // HIT! Reflect the ball
        this.gameState.ballVelocityX = -Math.abs(this.gameState.ballVelocityX);
        this.gameState.ballX = paddle2Left - GAME_CONFIG.BALL_SIZE / 2;

        // Add spin based on where ball hit paddle
        const paddleCenter = (paddle2Top + paddle2Bottom) / 2;
        const hitPosition = (crossY - paddleCenter) / (GAME_CONFIG.PADDLE_HEIGHT / 2);
        this.gameState.ballVelocityY += hitPosition * 3;

        // Increase ball speed slightly
        this.speedUpBall();
      }
    }

    // Check for scoring (ball went off left or right edge)
    if (this.gameState.ballX <= 0) {
      // Player 2 scored (ball went off left)
      this.gameState.score2++;
      this.resetBall();
    } else if (this.gameState.ballX >= GAME_CONFIG.CANVAS_WIDTH) {
      // Player 1 scored (ball went off right)
      this.gameState.score1++;
      this.resetBall();
    }

    // Check for game over
    if (this.gameState.score1 >= GAME_CONFIG.WINNING_SCORE) {
      this.endGame('left');
    } else if (this.gameState.score2 >= GAME_CONFIG.WINNING_SCORE) {
      this.endGame('right');
    }
  }

  /**
   * Increase ball speed up to max
   */
  private speedUpBall() {
    const currentSpeed = Math.sqrt(
      this.gameState.ballVelocityX ** 2 + this.gameState.ballVelocityY ** 2
    );

    if (currentSpeed < GAME_CONFIG.MAX_BALL_SPEED) {
      const speedMultiplier = 1 + GAME_CONFIG.BALL_SPEED_INCREMENT / currentSpeed;
      this.gameState.ballVelocityX *= speedMultiplier;
      this.gameState.ballVelocityY *= speedMultiplier;
    }
  }

  /**
   * Reset ball to center after scoring
   */
  private resetBall() {
    this.gameState.ballX = GAME_CONFIG.CANVAS_WIDTH / 2;
    this.gameState.ballY = GAME_CONFIG.CANVAS_HEIGHT / 2;

    // Reset previous position tracking
    this.prevBallX = this.gameState.ballX;
    this.prevBallY = this.gameState.ballY;

    // Random direction
    const angle = (Math.random() * Math.PI / 2) - Math.PI / 4; // -45 to 45 degrees
    const direction = Math.random() > 0.5 ? 1 : -1;

    this.gameState.ballVelocityX = Math.cos(angle) * GAME_CONFIG.INITIAL_BALL_SPEED * direction;
    this.gameState.ballVelocityY = Math.sin(angle) * GAME_CONFIG.INITIAL_BALL_SPEED;
  }

  /**
   * End the game and notify players
   */
  private endGame(winner: 'left' | 'right') {
    console.log(`🏆 Game over! Winner: ${winner}`);

    // Stop game loop
    if (this.gameLoop) {
      clearInterval(this.gameLoop);
      this.gameLoop = null;
    }

    // Send game over message to both players
    const message = {
      type: 'game_over' as const,
      winner,
      finalScore: {
        left: this.gameState.score1,
        right: this.gameState.score2,
      },
    };

    this.sendToPlayer(this.player1.ws, message);
    this.sendToPlayer(this.player2.ws, message);
  }

  /**
   * Update paddle position for a player
   */
  updatePaddlePosition(playerWs: WebSocket, y: number) {
    // Clamp paddle position to canvas bounds (Y is center of paddle)
    const clampedY = Math.max(
      GAME_CONFIG.PADDLE_HEIGHT / 2,
      Math.min(GAME_CONFIG.CANVAS_HEIGHT - GAME_CONFIG.PADDLE_HEIGHT / 2, y)
    );

    if (playerWs === this.player1.ws) {
      this.gameState.paddle1Y = clampedY;
    } else if (playerWs === this.player2.ws) {
      this.gameState.paddle2Y = clampedY;
    }
  }

  /**
   * Broadcast current game state to both players
   */
  private broadcastGameState() {
    const message = {
      type: 'game_state' as const,
      state: this.gameState,
    };

    this.sendToPlayer(this.player1.ws, message);
    this.sendToPlayer(this.player2.ws, message);
  }

  /**
   * Send message to a player (with error handling)
   */
  private sendToPlayer(ws: WebSocket, message: any) {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(message));
      }
    } catch (error) {
      console.error('Error sending message to player:', error);
    }
  }

  /**
   * Handle player disconnect
   */
  handleDisconnect(playerWs: WebSocket) {
    console.log('👋 Player disconnected from game');

    // Stop game
    if (this.gameLoop) {
      clearInterval(this.gameLoop);
      this.gameLoop = null;
    }
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }

    // Notify other player
    const otherPlayer = playerWs === this.player1.ws ? this.player2 : this.player1;
    this.sendToPlayer(otherPlayer.ws, { type: 'opponent_disconnected' });
  }

  /**
   * Clean up resources
   */
  cleanup() {
    if (this.gameLoop) {
      clearInterval(this.gameLoop);
      this.gameLoop = null;
    }
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  /**
   * Get player websocket references
   */
  getPlayers() {
    return [this.player1.ws, this.player2.ws];
  }
}

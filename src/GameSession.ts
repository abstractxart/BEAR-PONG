/**
 * GameSession - Handles the physics and state for a single Pong match
 */
import { GAME_CONFIG, GameState, PlayerData, UltimateAbilityType } from './types.js';
import type { WebSocket } from 'ws';

export class GameSession {
  private gameState: GameState;
  private player1: { ws: WebSocket; data: PlayerData };
  private player2: { ws: WebSocket; data: PlayerData };
  private gameLoop: NodeJS.Timeout | null = null;
  private countdown: number = GAME_CONFIG.COUNTDOWN_DURATION;
  private countdownInterval: NodeJS.Timeout | null = null;

  // 💰 BETTING: Track betting state
  private player1Bet: number = 0;
  private player2Bet: number = 0;
  private player1Ready: boolean = false;
  private player2Ready: boolean = false;
  private bettingTimer: NodeJS.Timeout | null = null;
  private finalBetAmount: number = 0;

  // Track previous ball position for continuous collision detection
  private prevBallX: number = 0;
  private prevBallY: number = 0;

  // 🚀 ULTIMATE ABILITIES: Track active ultimates
  private timeFreezeActive: boolean = false;
  private timeFreezeEndTime: number = 0;
  private ballSpeedMultiplier: number = 1; // For TIME_FREEZE
  private player1UsedUltimates: Set<string> = new Set();
  private player2UsedUltimates: Set<string> = new Set();
  private powerHitPlayer: number | null = null; // 1 or 2 if power hit is active

  // 🎉 SCORE COUNTDOWN: Pause game and show flashy 3-2-1-GO! after each goal
  private scoreCountdown: number = 3;
  private scoreCountdownInterval: NodeJS.Timeout | null = null;
  private isPaused: boolean = false;

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
      paddle1Height: GAME_CONFIG.PADDLE_HEIGHT,  // 🔥 Initialize paddle heights
      paddle2Height: GAME_CONFIG.PADDLE_HEIGHT,  // 🔥 Initialize paddle heights
      score1: 0,
      score2: 0,
      gameStarted: false,
      countdown: GAME_CONFIG.COUNTDOWN_DURATION,
    };
  }

  /**
   * 💰 BETTING: Start the betting lobby timer (30 seconds)
   */
  startBettingLobby() {
    console.log('💰 Starting betting lobby (30 seconds)...');

    this.bettingTimer = setTimeout(() => {
      console.log('⏰ Betting timer expired!');

      // If neither player is ready, disconnect both and return to menu
      if (!this.player1Ready && !this.player2Ready) {
        console.log('❌ Neither player ready - sending timeout to both');
        this.sendToPlayer(this.player1.ws, { type: 'betting_timeout' });
        this.sendToPlayer(this.player2.ws, { type: 'betting_timeout' });
        this.cleanup();
        return;
      }

      // If at least one player is ready, start game with their bet
      if (this.player1Ready || this.player2Ready) {
        console.log('✅ At least one player ready - starting game');

        // RULE: If either player bets 0, final bet is 0 (no betting mode)
        if (this.player1Bet === 0 || this.player2Bet === 0) {
          this.finalBetAmount = 0;
        } else {
          this.finalBetAmount = Math.min(this.player1Bet, this.player2Bet);
        }

        this.sendToPlayer(this.player1.ws, { type: 'final_bet_amount', amount: this.finalBetAmount });
        this.sendToPlayer(this.player2.ws, { type: 'final_bet_amount', amount: this.finalBetAmount });

        // Start game countdown
        this.start();
      }
    }, 30000); // 30 seconds
  }

  /**
   * 💰 BETTING: Handle player setting their bet
   */
  handleSetBet(playerWs: WebSocket, amount: number) {
    console.log(`💰 Player set bet: ${amount}`);

    if (playerWs === this.player1.ws) {
      this.player1Bet = amount;
      this.sendToPlayer(this.player2.ws, { type: 'opponent_bet_set', amount });
    } else if (playerWs === this.player2.ws) {
      this.player2Bet = amount;
      this.sendToPlayer(this.player1.ws, { type: 'opponent_bet_set', amount });
    }
  }

  /**
   * 💰 BETTING: Handle player clicking READY
   */
  handleReadyToStart(playerWs: WebSocket) {
    console.log('✅ Player is ready!');

    // Mark player as ready
    if (playerWs === this.player1.ws) {
      this.player1Ready = true;
    } else if (playerWs === this.player2.ws) {
      this.player2Ready = true;
    }

    // Notify opponent
    const opponent = playerWs === this.player1.ws ? this.player2 : this.player1;
    this.sendToPlayer(opponent.ws, { type: 'opponent_ready' });

    // If both ready, determine final bet and start game
    if (this.player1Ready && this.player2Ready) {
      console.log('🎮 Both players ready - starting game!');

      // RULE: If either player bets 0, final bet is 0 (no betting mode)
      if (this.player1Bet === 0 || this.player2Bet === 0) {
        this.finalBetAmount = 0;
      } else {
        this.finalBetAmount = Math.min(this.player1Bet, this.player2Bet);
      }
      console.log(`💰 Final bet amount: ${this.finalBetAmount}`);

      // Send final bet to both players
      this.sendToPlayer(this.player1.ws, { type: 'final_bet_amount', amount: this.finalBetAmount });
      this.sendToPlayer(this.player2.ws, { type: 'final_bet_amount', amount: this.finalBetAmount });

      // Cancel betting timer
      if (this.bettingTimer) {
        clearTimeout(this.bettingTimer);
        this.bettingTimer = null;
      }

      // Start countdown/game
      this.start();
    }
  }

  /**
   * 🚀 ULTIMATE ABILITIES: Handle player using an ultimate ability
   */
  handleUseUltimate(playerWs: WebSocket, abilityType: UltimateAbilityType) {
    console.log(`🚀 Player attempting to use ultimate: ${abilityType}`);

    // Determine which player and their used set
    const isPlayer1 = playerWs === this.player1.ws;
    const usedSet = isPlayer1 ? this.player1UsedUltimates : this.player2UsedUltimates;
    const playerSide: 'left' | 'right' = isPlayer1 ? 'left' : 'right';

    // Check if already used this ability
    if (usedSet.has(abilityType)) {
      console.log(`❌ ${abilityType} already used by ${playerSide}`);
      this.sendToPlayer(playerWs, { type: 'error', message: 'Ultimate already used!' });
      return;
    }

    // Mark as used
    usedSet.add(abilityType);
    console.log(`✅ ${abilityType} activated by ${playerSide}`);

    // Execute the ability
    switch (abilityType) {
      case 'time_freeze':
        this.activateTimeFreeze();
        break;
      case 'paddle_dash':
        this.activatePaddleDash(isPlayer1);
        break;
      case 'power_hit':
        this.activatePowerHit(isPlayer1);
        break;
    }

    // Broadcast to both players that ultimate was activated
    const message = {
      type: 'ultimate_activated' as const,
      side: playerSide,
      abilityType,
    };
    this.sendToPlayer(this.player1.ws, message);
    this.sendToPlayer(this.player2.ws, message);
  }

  /**
   * 🚀 TIME FREEZE: Reduce ball speed to 10% for 4 seconds (ULTRA SLOW-MO!)
   */
  private activateTimeFreeze() {
    console.log('⏰ TIME FREEZE activated - ball speed reduced to 10%');
    this.timeFreezeActive = true;
    this.ballSpeedMultiplier = 0.1; // ULTRA SLOW-MO (was 0.3)
    this.timeFreezeEndTime = Date.now() + 4000; // 4 seconds (was 3)
  }

  /**
   * 🚀 PADDLE DASH: Teleport paddle to ball's Y position
   */
  private activatePaddleDash(isPlayer1: boolean) {
    console.log(`⚡ PADDLE DASH activated - teleporting paddle to ball Y`);
    if (isPlayer1) {
      this.gameState.paddle1Y = this.gameState.ballY;
    } else {
      this.gameState.paddle2Y = this.gameState.ballY;
    }
  }

  /**
   * 🚀 POWER HIT: Next paddle hit increases ball speed significantly
   */
  private activatePowerHit(isPlayer1: boolean) {
    console.log(`💥 POWER HIT activated for player ${isPlayer1 ? 1 : 2}`);
    this.powerHitPlayer = isPlayer1 ? 1 : 2;
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
   * GODMODE: Zero-tunneling collision with swept detection + safety nets
   */
  private updatePhysics() {
    if (!this.gameState.gameStarted) return;
    if (this.isPaused) return; // 🎉 Pause during score countdown


    // 🚀 ULTIMATE ABILITIES: Check for TIME_FREEZE expiration
    if (this.timeFreezeActive && Date.now() >= this.timeFreezeEndTime) {
      console.log('⏰ TIME FREEZE expired - restoring normal ball speed');
      this.timeFreezeActive = false;
      this.ballSpeedMultiplier = 1;
    }

    // 🚀🔥 BROKEN SPEED MODE: Velocity clamping REMOVED!
    // Ball can now reach MAX_BALL_SPEED (35) - BG123 BROKEN MODE!


    // Store previous position for swept collision
    this.prevBallX = this.gameState.ballX;
    this.prevBallY = this.gameState.ballY;

    // Move ball (apply TIME_FREEZE multiplier if active)
    this.gameState.ballX += this.gameState.ballVelocityX * this.ballSpeedMultiplier;
    this.gameState.ballY += this.gameState.ballVelocityY * this.ballSpeedMultiplier;

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

    // ULTRA GODMODE: Calculate current ball speed for dynamic collision padding
    const currentSpeed = Math.sqrt(
      this.gameState.ballVelocityX * this.gameState.ballVelocityX +
      this.gameState.ballVelocityY * this.gameState.ballVelocityY
    );

    // ULTRA GODMODE: Dynamic collision padding that INCREASES with ball speed
    // Base: 50px + (speed - 6) * 8px scaling
    // At speed 6 (min): 50px padding
    // At speed 10 (gold): 50 + (4 * 8) = 82px padding
    // At speed 13 (red): 50 + (7 * 8) = 106px padding
    // At speed 15 (max): 50 + (9 * 8) = 122px padding
    const BASE_PADDING = 50;
    const SPEED_SCALING = 8; // Extra padding per speed unit
    const COLLISION_PADDING = BASE_PADDING + Math.max(0, (currentSpeed - GAME_CONFIG.INITIAL_BALL_SPEED) * SPEED_SCALING);

    console.log(`[ULTRA GODMODE] Speed: ${currentSpeed.toFixed(1)}, Padding: ${COLLISION_PADDING.toFixed(0)}px`);

    // Left paddle (player 1) - positioned at left edge
    const paddle1Left = 50;
    const paddle1Right = paddle1Left + GAME_CONFIG.PADDLE_WIDTH;
    // paddle1Y is the CENTER of the paddle (matches client-side Phaser Container positioning)
    const paddle1Top = this.gameState.paddle1Y - GAME_CONFIG.PADDLE_HEIGHT / 2;
    const paddle1Bottom = this.gameState.paddle1Y + GAME_CONFIG.PADDLE_HEIGHT / 2;

    // TIER 1: Check if ball crossed the paddle's X boundary (SWEPT DETECTION)
    let leftPaddleHit = false;
    if (
      this.gameState.ballVelocityX < 0 && // Moving left
      this.prevBallX - GAME_CONFIG.BALL_SIZE / 2 > paddle1Right && // Was to the right
      this.gameState.ballX - GAME_CONFIG.BALL_SIZE / 2 <= paddle1Right + COLLISION_PADDING // Now at or past paddle (with padding)
    ) {
      // Calculate Y position when ball crosses paddle's X
      const t = (paddle1Right - (this.prevBallX - GAME_CONFIG.BALL_SIZE / 2)) / this.gameState.ballVelocityX;
      const crossY = this.prevBallY + (this.gameState.ballVelocityY * t);

      // Check if Y position is within paddle bounds (EXACT - no padding on Y axis!)
      const minY = paddle1Top - GAME_CONFIG.BALL_SIZE / 2;
      const maxY = paddle1Bottom + GAME_CONFIG.BALL_SIZE / 2;

      if (crossY >= minY && crossY <= maxY) {
        // HIT! TIER 7: Guaranteed bounce response
        console.log(`[COLLISION] Left paddle HIT! crossY=${crossY.toFixed(1)}, paddleY=${this.gameState.paddle1Y.toFixed(1)}, range=${minY.toFixed(1)}-${maxY.toFixed(1)}`);
        this.gameState.ballVelocityX = Math.abs(this.gameState.ballVelocityX);

        // TIER 7: Force ball OUTSIDE paddle bounds (safety margin)
        this.gameState.ballX = paddle1Right + GAME_CONFIG.BALL_SIZE / 2 + 2;

        // GODMODE FUN: Add spin based on where ball hit paddle (CLAMPED for fun)
        const paddleCenter = (paddle1Top + paddle1Bottom) / 2;
        const hitPosition = (crossY - paddleCenter) / (GAME_CONFIG.PADDLE_HEIGHT / 2);

        // 🔥 JUICE: PERFECT HIT ZONE (center 30% of paddle)
        const isPerfectHit = Math.abs(hitPosition) <= 0.15;
        if (isPerfectHit) {
          console.log(`[PERFECT HIT!] Left paddle - Center shot! hitPosition=${hitPosition.toFixed(2)}`);
        }

        // Spin strength scales with speed (gold/red = more horizontal bias)
        const spinStrength = currentSpeed >= 10 ? 2 : 3; // Less spin at high speeds
        this.gameState.ballVelocityY += hitPosition * spinStrength;

        // GODMODE FUN: Limit vertical velocity to prevent boring up/down bouncing
        const MAX_Y_VELOCITY = currentSpeed >= 10 ? 4 : 6; // Gold/red: even more horizontal
        this.gameState.ballVelocityY = Math.max(-MAX_Y_VELOCITY, Math.min(MAX_Y_VELOCITY, this.gameState.ballVelocityY));

        // GODMODE FUN: Ensure minimum horizontal velocity (especially at high speeds)
        const MIN_X_VELOCITY = currentSpeed >= 10 ? currentSpeed * 0.75 : currentSpeed * 0.5;
        if (Math.abs(this.gameState.ballVelocityX) < MIN_X_VELOCITY) {
          this.gameState.ballVelocityX = Math.sign(this.gameState.ballVelocityX) * MIN_X_VELOCITY;
        }

        // Increase ball speed slightly
        this.speedUpBall();

        // 🔥 JUICE: PERFECT HIT = DOUBLE SPEED BONUS!
        if (isPerfectHit) {
          this.speedUpBall(); // BONUS speed increase!
        }

        // 🚀 ULTIMATE: POWER HIT - Apply massive speed boost if active
        if (this.powerHitPlayer === 1) {
          console.log('💥 POWER HIT triggered on left paddle - INSANE SPEED BOOST!');
          this.speedUpBall();
          this.speedUpBall();
          this.speedUpBall();
          this.speedUpBall();
          this.speedUpBall();
          this.speedUpBall();
          this.speedUpBall();
          this.speedUpBall(); // 8x speed boost!
          this.powerHitPlayer = null; // Clear after use
        }

        leftPaddleHit = true;
      } else {
        // MISS! Log why
        console.log(`[COLLISION] Left paddle MISS! crossY=${crossY.toFixed(1)}, paddleY=${this.gameState.paddle1Y.toFixed(1)}, range=${minY.toFixed(1)}-${maxY.toFixed(1)}, diff=${crossY < minY ? (crossY - minY).toFixed(1) : (crossY - maxY).toFixed(1)}`);
      }
    }

    // ULTRA GODMODE FAILSAFE: Emergency collision check for left paddle
    // If ball is ALREADY INSIDE/PAST paddle zone but within Y bounds, force bounce
    if (
      !leftPaddleHit && // Haven't already registered a hit
      this.gameState.ballVelocityX < 0 && // Moving left
      this.gameState.ballX - GAME_CONFIG.BALL_SIZE / 2 <= paddle1Right && // Past paddle X
      this.gameState.ballX + GAME_CONFIG.BALL_SIZE / 2 >= paddle1Left && // But not completely past
      this.gameState.ballY >= paddle1Top - GAME_CONFIG.BALL_SIZE / 2 && // Within paddle Y (EXACT - no extra padding!)
      this.gameState.ballY <= paddle1Bottom + GAME_CONFIG.BALL_SIZE / 2
    ) {
      console.log(`[EMERGENCY] Left paddle FAILSAFE TRIGGERED! ballX=${this.gameState.ballX.toFixed(1)}, ballY=${this.gameState.ballY.toFixed(1)}`);
      this.gameState.ballVelocityX = Math.abs(this.gameState.ballVelocityX);
      this.gameState.ballX = paddle1Right + GAME_CONFIG.BALL_SIZE / 2 + 2;

      // GODMODE FUN: Add spin (emergency bounce)
      const paddleCenter = (paddle1Top + paddle1Bottom) / 2;
      const hitPosition = (this.gameState.ballY - paddleCenter) / (GAME_CONFIG.PADDLE_HEIGHT / 2);

      // 🔥 JUICE: PERFECT HIT ZONE (center 30% of paddle)
      const isPerfectHit = Math.abs(hitPosition) <= 0.15;
      if (isPerfectHit) {
        console.log(`[PERFECT HIT!] Left paddle FAILSAFE - Center shot! hitPosition=${hitPosition.toFixed(2)}`);
      }

      const spinStrength = currentSpeed >= 10 ? 2 : 3;
      this.gameState.ballVelocityY += hitPosition * spinStrength;

      // GODMODE FUN: Clamp Y velocity and ensure horizontal bias
      const MAX_Y_VELOCITY = currentSpeed >= 10 ? 4 : 6;
      this.gameState.ballVelocityY = Math.max(-MAX_Y_VELOCITY, Math.min(MAX_Y_VELOCITY, this.gameState.ballVelocityY));

      const MIN_X_VELOCITY = currentSpeed >= 10 ? currentSpeed * 0.75 : currentSpeed * 0.5;
      if (Math.abs(this.gameState.ballVelocityX) < MIN_X_VELOCITY) {
        this.gameState.ballVelocityX = Math.sign(this.gameState.ballVelocityX) * MIN_X_VELOCITY;
      }

      this.speedUpBall();

      // 🔥 JUICE: PERFECT HIT = DOUBLE SPEED BONUS!
      if (isPerfectHit) {
        this.speedUpBall(); // BONUS speed increase!
      }

      // 🚀 ULTIMATE: POWER HIT - Apply massive speed boost if active
      if (this.powerHitPlayer === 1) {
        console.log('💥 POWER HIT triggered on left paddle FAILSAFE - INSANE SPEED BOOST!');
        this.speedUpBall();
        this.speedUpBall();
        this.speedUpBall();
        this.speedUpBall();
        this.speedUpBall();
        this.speedUpBall();
        this.speedUpBall();
        this.speedUpBall(); // 8x speed boost!
        this.powerHitPlayer = null; // Clear after use
      }
    }

    // Right paddle (player 2) - positioned at right edge
    const paddle2Left = GAME_CONFIG.CANVAS_WIDTH - 50 - GAME_CONFIG.PADDLE_WIDTH;
    const paddle2Right = paddle2Left + GAME_CONFIG.PADDLE_WIDTH;
    // paddle2Y is the CENTER of the paddle (matches client-side Phaser Container positioning)
    const paddle2Top = this.gameState.paddle2Y - GAME_CONFIG.PADDLE_HEIGHT / 2;
    const paddle2Bottom = this.gameState.paddle2Y + GAME_CONFIG.PADDLE_HEIGHT / 2;

    // TIER 1: Check if ball crossed the paddle's X boundary (SWEPT DETECTION)
    let rightPaddleHit = false;
    if (
      this.gameState.ballVelocityX > 0 && // Moving right
      this.prevBallX + GAME_CONFIG.BALL_SIZE / 2 < paddle2Left && // Was to the left
      this.gameState.ballX + GAME_CONFIG.BALL_SIZE / 2 >= paddle2Left - COLLISION_PADDING // Now at or past paddle (with padding)
    ) {
      // Calculate Y position when ball crosses paddle's X
      const t = (paddle2Left - (this.prevBallX + GAME_CONFIG.BALL_SIZE / 2)) / this.gameState.ballVelocityX;
      const crossY = this.prevBallY + (this.gameState.ballVelocityY * t);

      // Check if Y position is within paddle bounds (EXACT - no padding on Y axis!)
      const minY = paddle2Top - GAME_CONFIG.BALL_SIZE / 2;
      const maxY = paddle2Bottom + GAME_CONFIG.BALL_SIZE / 2;

      if (crossY >= minY && crossY <= maxY) {
        // HIT! TIER 7: Guaranteed bounce response
        console.log(`[COLLISION] Right paddle HIT! crossY=${crossY.toFixed(1)}, paddleY=${this.gameState.paddle2Y.toFixed(1)}, range=${minY.toFixed(1)}-${maxY.toFixed(1)}`);
        this.gameState.ballVelocityX = -Math.abs(this.gameState.ballVelocityX);

        // TIER 7: Force ball OUTSIDE paddle bounds (safety margin)
        this.gameState.ballX = paddle2Left - GAME_CONFIG.BALL_SIZE / 2 - 2;

        // GODMODE FUN: Add spin based on where ball hit paddle (CLAMPED for fun)
        const paddleCenter = (paddle2Top + paddle2Bottom) / 2;
        const hitPosition = (crossY - paddleCenter) / (GAME_CONFIG.PADDLE_HEIGHT / 2);

        // 🔥 JUICE: PERFECT HIT ZONE (center 30% of paddle)
        const isPerfectHit = Math.abs(hitPosition) <= 0.15;
        if (isPerfectHit) {
          console.log(`[PERFECT HIT!] Right paddle - Center shot! hitPosition=${hitPosition.toFixed(2)}`);
        }

        // Spin strength scales with speed (gold/red = more horizontal bias)
        const spinStrength = currentSpeed >= 10 ? 2 : 3; // Less spin at high speeds
        this.gameState.ballVelocityY += hitPosition * spinStrength;

        // GODMODE FUN: Limit vertical velocity to prevent boring up/down bouncing
        const MAX_Y_VELOCITY = currentSpeed >= 10 ? 4 : 6; // Gold/red: even more horizontal
        this.gameState.ballVelocityY = Math.max(-MAX_Y_VELOCITY, Math.min(MAX_Y_VELOCITY, this.gameState.ballVelocityY));

        // GODMODE FUN: Ensure minimum horizontal velocity (especially at high speeds)
        const MIN_X_VELOCITY = currentSpeed >= 10 ? currentSpeed * 0.75 : currentSpeed * 0.5;
        if (Math.abs(this.gameState.ballVelocityX) < MIN_X_VELOCITY) {
          this.gameState.ballVelocityX = Math.sign(this.gameState.ballVelocityX) * MIN_X_VELOCITY;
        }

        // Increase ball speed slightly
        this.speedUpBall();

        // 🔥 JUICE: PERFECT HIT = DOUBLE SPEED BONUS!
        if (isPerfectHit) {
          this.speedUpBall(); // BONUS speed increase!
        }

        // 🚀 ULTIMATE: POWER HIT - Apply massive speed boost if active
        if (this.powerHitPlayer === 2) {
          console.log('💥 POWER HIT triggered on right paddle - INSANE SPEED BOOST!');
          this.speedUpBall();
          this.speedUpBall();
          this.speedUpBall();
          this.speedUpBall();
          this.speedUpBall();
          this.speedUpBall();
          this.speedUpBall();
          this.speedUpBall(); // 8x speed boost!
          this.powerHitPlayer = null; // Clear after use
        }

        rightPaddleHit = true;
      } else {
        // MISS! Log why
        console.log(`[COLLISION] Right paddle MISS! crossY=${crossY.toFixed(1)}, paddleY=${this.gameState.paddle2Y.toFixed(1)}, range=${minY.toFixed(1)}-${maxY.toFixed(1)}, diff=${crossY < minY ? (crossY - minY).toFixed(1) : (crossY - maxY).toFixed(1)}`);
      }
    }

    // ULTRA GODMODE FAILSAFE: Emergency collision check for right paddle
    // If ball is ALREADY INSIDE/PAST paddle zone but within Y bounds, force bounce
    if (
      !rightPaddleHit && // Haven't already registered a hit
      this.gameState.ballVelocityX > 0 && // Moving right
      this.gameState.ballX + GAME_CONFIG.BALL_SIZE / 2 >= paddle2Left && // Past paddle X
      this.gameState.ballX - GAME_CONFIG.BALL_SIZE / 2 <= paddle2Right && // But not completely past
      this.gameState.ballY >= paddle2Top - GAME_CONFIG.BALL_SIZE / 2 && // Within paddle Y (EXACT - no extra padding!)
      this.gameState.ballY <= paddle2Bottom + GAME_CONFIG.BALL_SIZE / 2
    ) {
      console.log(`[EMERGENCY] Right paddle FAILSAFE TRIGGERED! ballX=${this.gameState.ballX.toFixed(1)}, ballY=${this.gameState.ballY.toFixed(1)}`);
      this.gameState.ballVelocityX = -Math.abs(this.gameState.ballVelocityX);
      this.gameState.ballX = paddle2Left - GAME_CONFIG.BALL_SIZE / 2 - 2;

      // GODMODE FUN: Add spin (emergency bounce)
      const paddleCenter = (paddle2Top + paddle2Bottom) / 2;
      const hitPosition = (this.gameState.ballY - paddleCenter) / (GAME_CONFIG.PADDLE_HEIGHT / 2);

      // 🔥 JUICE: PERFECT HIT ZONE (center 30% of paddle)
      const isPerfectHit = Math.abs(hitPosition) <= 0.15;
      if (isPerfectHit) {
        console.log(`[PERFECT HIT!] Right paddle FAILSAFE - Center shot! hitPosition=${hitPosition.toFixed(2)}`);
      }

      const spinStrength = currentSpeed >= 10 ? 2 : 3;
      this.gameState.ballVelocityY += hitPosition * spinStrength;

      // GODMODE FUN: Clamp Y velocity and ensure horizontal bias
      const MAX_Y_VELOCITY = currentSpeed >= 10 ? 4 : 6;
      this.gameState.ballVelocityY = Math.max(-MAX_Y_VELOCITY, Math.min(MAX_Y_VELOCITY, this.gameState.ballVelocityY));

      const MIN_X_VELOCITY = currentSpeed >= 10 ? currentSpeed * 0.75 : currentSpeed * 0.5;
      if (Math.abs(this.gameState.ballVelocityX) < MIN_X_VELOCITY) {
        this.gameState.ballVelocityX = Math.sign(this.gameState.ballVelocityX) * MIN_X_VELOCITY;
      }

      this.speedUpBall();

      // 🔥 JUICE: PERFECT HIT = DOUBLE SPEED BONUS!
      if (isPerfectHit) {
        this.speedUpBall(); // BONUS speed increase!
      }

      // 🚀 ULTIMATE: POWER HIT - Apply massive speed boost if active
      if (this.powerHitPlayer === 2) {
        console.log('💥 POWER HIT triggered on right paddle FAILSAFE - INSANE SPEED BOOST!');
        this.speedUpBall();
        this.speedUpBall();
        this.speedUpBall();
        this.speedUpBall();
        this.speedUpBall();
        this.speedUpBall();
        this.speedUpBall();
        this.speedUpBall(); // 8x speed boost!
        this.powerHitPlayer = null; // Clear after use
      }
    }

    // Check for scoring (ball went off left or right edge)
    if (this.gameState.ballX <= 0) {
      // Player 2 scored (ball went off left)
      this.gameState.score2++;
      console.log(`🎯 Player 2 scored! Score: ${this.gameState.score1} - ${this.gameState.score2}`);

      // Check for game over BEFORE starting countdown
      if (this.gameState.score2 >= GAME_CONFIG.WINNING_SCORE) {
        console.log(`🏆 GAME OVER! Player 2 wins with score ${this.gameState.score2} >= ${GAME_CONFIG.WINNING_SCORE}`);
        this.endGame('right');
        return; // Don't start countdown if game is over
      }

      console.log(`📊 Starting countdown (score not yet at ${GAME_CONFIG.WINNING_SCORE})`);
      this.startScoreCountdown(); // 🎉 Start flashy countdown!
    } else if (this.gameState.ballX >= GAME_CONFIG.CANVAS_WIDTH) {
      // Player 1 scored (ball went off right)
      this.gameState.score1++;
      console.log(`🎯 Player 1 scored! Score: ${this.gameState.score1} - ${this.gameState.score2}`);

      // Check for game over BEFORE starting countdown
      if (this.gameState.score1 >= GAME_CONFIG.WINNING_SCORE) {
        console.log(`🏆 GAME OVER! Player 1 wins with score ${this.gameState.score1} >= ${GAME_CONFIG.WINNING_SCORE}`);
        this.endGame('left');
        return; // Don't start countdown if game is over
      }

      console.log(`📊 Starting countdown (score not yet at ${GAME_CONFIG.WINNING_SCORE})`);
      this.startScoreCountdown(); // 🎉 Start flashy countdown!
    }
  }

  /**
   * Increase ball speed up to max AND shrink paddles progressively
   */
  private speedUpBall() {
    const currentSpeed = Math.sqrt(
      this.gameState.ballVelocityX ** 2 + this.gameState.ballVelocityY ** 2
    );

    if (currentSpeed < GAME_CONFIG.MAX_BALL_SPEED) {
      // 🚀 AGGRESSIVE SPEED INCREASE: Fixed multiplier for consistent ramping
      const speedMultiplier = 1 + GAME_CONFIG.BALL_SPEED_INCREMENT;
      const newVelX = this.gameState.ballVelocityX * speedMultiplier;
      const newVelY = this.gameState.ballVelocityY * speedMultiplier;
      
      // Calculate new speed and cap at max
      const newSpeed = Math.sqrt(newVelX ** 2 + newVelY ** 2);
      if (newSpeed <= GAME_CONFIG.MAX_BALL_SPEED) {
        this.gameState.ballVelocityX = newVelX;
        this.gameState.ballVelocityY = newVelY;
      } else {
        // Cap at max speed while preserving direction
        const angle = Math.atan2(this.gameState.ballVelocityY, this.gameState.ballVelocityX);
        this.gameState.ballVelocityX = Math.cos(angle) * GAME_CONFIG.MAX_BALL_SPEED;
        this.gameState.ballVelocityY = Math.sin(angle) * GAME_CONFIG.MAX_BALL_SPEED;
      }
    }

    // 🔥 SHRINK PADDLES progressively (down to 33% minimum)
    if (this.gameState.paddle1Height > GAME_CONFIG.MIN_PADDLE_HEIGHT) {
      this.gameState.paddle1Height = Math.max(
        GAME_CONFIG.MIN_PADDLE_HEIGHT,
        this.gameState.paddle1Height - GAME_CONFIG.PADDLE_SHRINK_PER_HIT
      );
    }
    if (this.gameState.paddle2Height > GAME_CONFIG.MIN_PADDLE_HEIGHT) {
      this.gameState.paddle2Height = Math.max(
        GAME_CONFIG.MIN_PADDLE_HEIGHT,
        this.gameState.paddle2Height - GAME_CONFIG.PADDLE_SHRINK_PER_HIT
      );
    }
  }

  /**
   * Reset ball to center after scoring
   */
  /**
   * 🎉 Start flashy 3-2-1-GO! countdown after scoring
   */
  private startScoreCountdown() {
    console.log("🎉 Starting score countdown: 3... 2... 1... GO!");
    
    // Pause the game
    this.isPaused = true;
    
    // Reset countdown
    this.scoreCountdown = 3;
    
    // Send initial countdown (3)
    this.sendToPlayer(this.player1.ws, { type: "countdown", count: this.scoreCountdown });
    this.sendToPlayer(this.player2.ws, { type: "countdown", count: this.scoreCountdown });
    
    // Start countdown interval
    this.scoreCountdownInterval = setInterval(() => {
      this.scoreCountdown--;
      
      if (this.scoreCountdown > 0) {
        // Send countdown numbers (2, 1)
        this.sendToPlayer(this.player1.ws, { type: "countdown", count: this.scoreCountdown });
        this.sendToPlayer(this.player2.ws, { type: "countdown", count: this.scoreCountdown });
      } else {
        // Send GO! (count = 0)
        this.sendToPlayer(this.player1.ws, { type: "countdown", count: 0 });
        this.sendToPlayer(this.player2.ws, { type: "countdown", count: 0 });
        
        // Stop countdown and resume game
        if (this.scoreCountdownInterval) {
          clearInterval(this.scoreCountdownInterval);
          this.scoreCountdownInterval = null;
        }
        
        // Reset ball and resume
        this.resetBall();
        this.isPaused = false;
        
        console.log("🎉 Countdown complete - game resumed!");
      }
    }, 1000); // 1 second intervals
  }

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
      betAmount: this.finalBetAmount,
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
    if (this.bettingTimer) {
      clearTimeout(this.bettingTimer);
      this.bettingTimer = null;
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
    if (this.bettingTimer) {
      clearTimeout(this.bettingTimer);
      this.bettingTimer = null;
    }
  }

  /**
   * Get player websocket references
   */
  getPlayers() {
    return [this.player1.ws, this.player2.ws];
  }
}

/**
 * GameSession - the physics and state for a single Pong match.
 *
 * CONTACT (protocol 2). The old collision decided a hit as soon as the ball
 * came within a speed-scaled padding of the paddle - up to ~200px early -
 * against whatever paddle position had arrived by then, and teleported the
 * ball onto the face. With network delay on top, what a player saw and what
 * the server decided routinely disagreed.
 *
 * Now a hit happens where the ball ACTUALLY crosses the paddle face:
 *
 *   touch      the ball's path crosses the face plane this tick (swept, so
 *              no speed can tunnel through). It stops on the face.
 *   strike     the defender's paddle covers the crossing: a hit. The ball is
 *              held on the face for a hit-stop (longer for PERFECT / EDGE /
 *              POWER) and both screens see it stick to the paddle, then fly.
 *   grace      the server's copy of the paddle is behind the player's own:
 *              it left their machine one-way-latency ago, and they saw the
 *              ball one-way-latency late. So if it is not there yet, wait one
 *              of THEIR round trips (measured by ping) plus jitter for the
 *              paddle the player actually had when they saw the ball arrive.
 *              Any of their paddle samples arriving in that window that
 *              covers the crossing is a hit. What you saw is what you get.
 *   miss       no cover in time: the ball carries on through to the line. A
 *              paddle far beyond reach skips the wait.
 *
 * BEAR CURVE: the defender's swing speed at contact (from their own paddle
 * timestamps) puts spin on the ball - see curve.ts.
 *
 * Old clients (protocol 1) get the same exact contact, a fixed grace, and
 * simply ignore the new fields and messages.
 */
import { GAME_CONFIG, GameState, PlayerData, SERVER_PROTOCOL, UltimateAbilityType } from './types.js';
import { applyCurve, RANKED_CURVE, spinFromSwing } from './curve.js';
import type { WebSocket } from 'ws';

type Seat = 1 | 2;

/** A paddle position as it arrived: server time, the client's own clock, y. */
interface PaddleSample {
  at: number;
  ct: number;
  y: number;
}

/** The ball is on a paddle face: struck (hit-stop) or waiting on a late paddle. */
interface Contact {
  seat: Seat;
  face: number;
  crossY: number;
  since: number;
  deadline: number;
  hitAt: number | null;
  releaseAt: number;
}

const R = GAME_CONFIG.BALL_SIZE / 2;
/** where the ball's CENTRE touches each face */
const LEFT_FACE = 50 + GAME_CONFIG.PADDLE_WIDTH + R;
const RIGHT_FACE = GAME_CONFIG.CANVAS_WIDTH - 50 - GAME_CONFIG.PADDLE_WIDTH - R;
/** the paddle that collides is always the full 120 (the reported heights are cosmetic) */
const REACH = GAME_CONFIG.PADDLE_HEIGHT / 2 + R;

const HITSTOP_MS = 34;
const BIG_HITSTOP_MS = 75;
const GRACE = {
  /** added to the defender's round trip: the paddle sample can arrive a little late */
  jitter: 45,
  min: 60,
  max: 260,
  /** for clients that never answer pings (protocol 1) */
  fallback: 120,
  /** a paddle further than this from the crossing cannot get there - do not wait */
  reach: 280,
};
const SAMPLE_MEMORY_MS = 600;

export class GameSession {
  private gameState: GameState;
  private player1: { ws: WebSocket; data: PlayerData };
  private player2: { ws: WebSocket; data: PlayerData };
  private gameLoop: NodeJS.Timeout | null = null;
  private pingLoop: NodeJS.Timeout | null = null;
  private countdown: number = GAME_CONFIG.COUNTDOWN_DURATION;
  private countdownInterval: NodeJS.Timeout | null = null;
  private started = false;
  /** the match has finished (game over or a player gone) */
  ended = false;

  // 💰 BETTING (retired; kept so old clients and the READY handshake still work)
  private player1Bet: number = 0;
  private player2Bet: number = 0;
  private player1Ready: boolean = false;
  private player2Ready: boolean = false;
  private bettingTimer: NodeJS.Timeout | null = null;
  private finalBetAmount: number = 0;

  // Track previous ball position for swept collision
  private prevBallX: number = 0;
  private prevBallY: number = 0;

  // 🚀 ULTIMATE ABILITIES
  private timeFreezeActive: boolean = false;
  private timeFreezeEndTime: number = 0;
  private ballSpeedMultiplier: number = 1; // For TIME_FREEZE
  private player1UsedUltimates: Set<string> = new Set();
  private player2UsedUltimates: Set<string> = new Set();
  private powerHitPlayer: number | null = null; // 1 or 2 if power hit is active

  // 🎉 SCORE COUNTDOWN
  private scoreCountdown: number = 3;
  private scoreCountdownInterval: NodeJS.Timeout | null = null;
  private isPaused: boolean = false;

  // CONTACT + BEAR CURVE
  private contact: Contact | null = null;
  /** the ball already went past this seat's face (a miss): do not touch again */
  private passed: Seat | null = null;
  private samples: Record<Seat, PaddleSample[]> = { 1: [], 2: [] };
  private rtt: Record<Seat, number | null> = { 1: null, 2: null };
  private ballSpin = 0;
  private ballAge = 0;

  constructor(
    player1: { ws: WebSocket; data: PlayerData },
    player2: { ws: WebSocket; data: PlayerData }
  ) {
    this.player1 = player1;
    this.player2 = player2;

    this.gameState = {
      ballX: GAME_CONFIG.CANVAS_WIDTH / 2,
      ballY: GAME_CONFIG.CANVAS_HEIGHT / 2,
      ballVelocityX: GAME_CONFIG.INITIAL_BALL_SPEED * (Math.random() > 0.5 ? 1 : -1),
      ballVelocityY: GAME_CONFIG.INITIAL_BALL_SPEED * (Math.random() * 2 - 1),
      paddle1Y: GAME_CONFIG.CANVAS_HEIGHT / 2,
      paddle2Y: GAME_CONFIG.CANVAS_HEIGHT / 2,
      paddle1Height: GAME_CONFIG.PADDLE_HEIGHT,
      paddle2Height: GAME_CONFIG.PADDLE_HEIGHT,
      score1: 0,
      score2: 0,
      gameStarted: false,
      countdown: GAME_CONFIG.COUNTDOWN_DURATION,
      ballSpin: 0,
      hold: false,
    };
  }

  /** Is this the session for a client that speaks protocol 2? */
  private v2(seat: Seat): boolean {
    return ((seat === 1 ? this.player1 : this.player2).data.protocol ?? 1) >= SERVER_PROTOCOL;
  }

  private seatOf(ws: WebSocket): Seat | null {
    return ws === this.player1.ws ? 1 : ws === this.player2.ws ? 2 : null;
  }

  // ============================================================ READY lobby
  /**
   * 💰 BETTING lobby, now just the READY handshake: the game starts when both
   * players ready, or 30s in if one did. Never twice (see start()).
   */
  startBettingLobby() {
    console.log('💰 Starting ready lobby (30 seconds)...');
    if (this.started || this.ended) return; // both readied before the lobby opened

    this.bettingTimer = setTimeout(() => {
      this.bettingTimer = null;
      if (this.started || this.ended) return;
      if (!this.player1Ready && !this.player2Ready) {
        console.log('❌ Neither player ready - sending timeout to both');
        this.sendToPlayer(this.player1.ws, { type: 'betting_timeout' });
        this.sendToPlayer(this.player2.ws, { type: 'betting_timeout' });
        this.ended = true;
        this.cleanup();
        return;
      }
      this.finalBetAmount = 0;
      this.sendToPlayer(this.player1.ws, { type: 'final_bet_amount', amount: this.finalBetAmount });
      this.sendToPlayer(this.player2.ws, { type: 'final_bet_amount', amount: this.finalBetAmount });
      this.start();
    }, 30000);
  }

  handleSetBet(playerWs: WebSocket, amount: number) {
    // Betting is retired; remembered only so an old client's flow still completes.
    if (playerWs === this.player1.ws) this.player1Bet = amount;
    else if (playerWs === this.player2.ws) this.player2Bet = amount;
  }

  handleReadyToStart(playerWs: WebSocket) {
    if (playerWs === this.player1.ws) this.player1Ready = true;
    else if (playerWs === this.player2.ws) this.player2Ready = true;
    else return;

    const opponent = playerWs === this.player1.ws ? this.player2 : this.player1;
    this.sendToPlayer(opponent.ws, { type: 'opponent_ready' });

    if (this.player1Ready && this.player2Ready && !this.started) {
      console.log('🎮 Both players ready - starting game!');
      this.finalBetAmount = 0;
      this.sendToPlayer(this.player1.ws, { type: 'final_bet_amount', amount: this.finalBetAmount });
      this.sendToPlayer(this.player2.ws, { type: 'final_bet_amount', amount: this.finalBetAmount });
      if (this.bettingTimer) {
        clearTimeout(this.bettingTimer);
        this.bettingTimer = null;
      }
      this.start();
    }
  }

  // ============================================================== abilities
  handleUseUltimate(playerWs: WebSocket, abilityType: UltimateAbilityType) {
    const seat = this.seatOf(playerWs);
    if (!seat) return;
    const usedSet = seat === 1 ? this.player1UsedUltimates : this.player2UsedUltimates;
    const playerSide: 'left' | 'right' = seat === 1 ? 'left' : 'right';

    // Only while the ball is in play: in a countdown they were simply wasted
    // (a freeze that expired in the pause, a dash to a parked ball).
    if (!this.gameState.gameStarted || this.isPaused || this.ended) {
      this.sendToPlayer(playerWs, { type: 'error', message: 'Abilities work once the ball is in play' });
      return;
    }
    if (usedSet.has(abilityType)) {
      this.sendToPlayer(playerWs, { type: 'error', message: 'Ultimate already used!' });
      return;
    }
    usedSet.add(abilityType);

    switch (abilityType) {
      case 'time_freeze':
        this.activateTimeFreeze();
        break;
      case 'paddle_dash':
        this.activatePaddleDash(seat === 1);
        break;
      case 'power_hit':
        this.activatePowerHit(seat === 1);
        break;
    }

    const message = { type: 'ultimate_activated' as const, side: playerSide, abilityType };
    this.sendToPlayer(this.player1.ws, message);
    this.sendToPlayer(this.player2.ws, message);
  }

  /** 🚀 TIME FREEZE: 3.33% ball speed for 1.3 seconds */
  private activateTimeFreeze() {
    this.timeFreezeActive = true;
    this.ballSpeedMultiplier = 0.0333;
    this.timeFreezeEndTime = Date.now() + 1300;
  }

  /** 🚀 PADDLE DASH: teleport the paddle to the ball's Y */
  private activatePaddleDash(isPlayer1: boolean) {
    const y = this.clampPaddle(this.gameState.ballY);
    if (isPlayer1) this.gameState.paddle1Y = y;
    else this.gameState.paddle2Y = y;
    this.samples[isPlayer1 ? 1 : 2].push({ at: Date.now(), ct: Date.now(), y });
  }

  /** 🚀 POWER HIT: the next paddle hit speeds the ball up three more times */
  private activatePowerHit(isPlayer1: boolean) {
    this.powerHitPlayer = isPlayer1 ? 1 : 2;
  }

  // ================================================================ timing
  /** Round trip, measured by ping (protocol 2). */
  handlePong(playerWs: WebSocket, t: number) {
    const seat = this.seatOf(playerWs);
    if (!seat || !Number.isFinite(t)) return;
    const sample = Date.now() - t;
    if (sample < 0 || sample > 2000) return;
    const prev = this.rtt[seat];
    this.rtt[seat] = prev === null ? sample : prev * 0.7 + sample * 0.3;
  }

  /** How long to wait for a defender's paddle that is not there yet. */
  private graceMs(seat: Seat): number {
    const rtt = this.rtt[seat];
    if (rtt === null) return GRACE.fallback;
    return Math.max(GRACE.min, Math.min(GRACE.max, rtt + GRACE.jitter));
  }

  // ================================================================= start
  /** Start the countdown and then the game. Idempotent: never two loops. */
  start() {
    if (this.started || this.ended) return;
    this.started = true;
    console.log('🎮 Starting countdown for match');

    this.countdownInterval = setInterval(() => {
      this.countdown--;
      this.gameState.countdown = this.countdown;
      this.sendToPlayer(this.player1.ws, { type: 'countdown', count: this.countdown });
      this.sendToPlayer(this.player2.ws, { type: 'countdown', count: this.countdown });
      if (this.countdown <= 0) this.startGame();
    }, 1000);
  }

  private startGame() {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    if (this.gameLoop || this.ended) return;

    this.gameState.gameStarted = true;
    this.gameState.countdown = undefined;
    console.log('🎮 Game started!');

    this.gameLoop = setInterval(() => {
      this.updatePhysics();
      this.broadcastGameState();
    }, 1000 / GAME_CONFIG.TICK_RATE);

    // round trips, for the grace window
    const ping = () => {
      const t = Date.now();
      if (this.v2(1)) this.sendToPlayer(this.player1.ws, { type: 'ping', t });
      if (this.v2(2)) this.sendToPlayer(this.player2.ws, { type: 'ping', t });
    };
    ping();
    this.pingLoop = setInterval(ping, 1000);
  }

  // =============================================================== physics
  private updatePhysics() {
    if (!this.gameState.gameStarted || this.isPaused || this.ended) return;
    const now = Date.now();

    if (this.timeFreezeActive && now >= this.timeFreezeEndTime) {
      this.timeFreezeActive = false;
      this.ballSpeedMultiplier = 1;
    }

    // the ball is on a paddle face: struck, or waiting on a late paddle
    if (this.contact && this.tickContact(now)) return;

    const scale = this.ballSpeedMultiplier;
    // BEAR CURVE
    if (this.ballSpin) {
      const v = { vx: this.gameState.ballVelocityX, vy: this.gameState.ballVelocityY };
      this.ballSpin = applyCurve(v, this.ballSpin, RANKED_CURVE, scale, this.ballAge);
      this.gameState.ballVelocityX = v.vx;
      this.gameState.ballVelocityY = v.vy;
    }
    this.ballAge += scale;

    this.prevBallX = this.gameState.ballX;
    this.prevBallY = this.gameState.ballY;
    this.gameState.ballX += this.gameState.ballVelocityX * scale;
    this.gameState.ballY += this.gameState.ballVelocityY * scale;

    // top/bottom walls
    if (this.gameState.ballY <= R || this.gameState.ballY >= GAME_CONFIG.CANVAS_HEIGHT - R) {
      this.gameState.ballVelocityY *= -1;
      this.gameState.ballY = Math.max(R, Math.min(GAME_CONFIG.CANVAS_HEIGHT - R, this.gameState.ballY));
      this.ballSpin *= RANKED_CURVE.wallKeep;
    }

    // the paddle faces (swept: any speed)
    const vx = this.gameState.ballVelocityX;
    if (vx < 0 && this.passed !== 1 && this.prevBallX > LEFT_FACE && this.gameState.ballX <= LEFT_FACE) {
      this.touch(1, LEFT_FACE, now);
      return;
    }
    if (vx > 0 && this.passed !== 2 && this.prevBallX < RIGHT_FACE && this.gameState.ballX >= RIGHT_FACE) {
      this.touch(2, RIGHT_FACE, now);
      return;
    }

    // scoring
    if (this.gameState.ballX <= 0) this.scoreFor(2);
    else if (this.gameState.ballX >= GAME_CONFIG.CANVAS_WIDTH) this.scoreFor(1);
  }

  /** The ball reaches a face: stop it there and decide - now, or after grace. */
  private touch(seat: Seat, face: number, now: number) {
    const dx = this.prevBallX - this.gameState.ballX;
    const t = dx !== 0 ? Math.max(0, Math.min(1, (this.prevBallX - face) / dx)) : 1;
    const crossY = Math.max(R, Math.min(GAME_CONFIG.CANVAS_HEIGHT - R, this.prevBallY + (this.gameState.ballY - this.prevBallY) * t));
    this.gameState.ballX = face;
    this.gameState.ballY = crossY;

    const paddleY = seat === 1 ? this.gameState.paddle1Y : this.gameState.paddle2Y;
    // a paddle that cannot possibly get there in time: no wait, straight through
    const far = Math.abs(crossY - paddleY) - REACH > GRACE.reach;
    this.contact = { seat, face, crossY, since: now, deadline: now + (far ? 0 : this.graceMs(seat)), hitAt: null, releaseAt: 0 };

    if (Math.abs(crossY - paddleY) <= REACH) this.strike(seat, paddleY, now);
    else if (far) this.letThrough(seat);
  }

  /** Returns true while the ball is still held on the face this tick. */
  private tickContact(now: number): boolean {
    const c = this.contact!;
    if (c.hitAt !== null) {
      if (now < c.releaseAt) return true;
      this.contact = null; // hit-stop over: away it goes, this very tick
      return false;
    }
    // Late paddle: anything the defender sent in the window that covers it.
    // (A sample that left them as they SAW the ball arrive lands one round
    // trip after the touch - inside the window.)
    const s = this.samples[c.seat].find((p) => p.at >= c.since - 20 && Math.abs(c.crossY - p.y) <= REACH);
    if (s) {
      this.strike(c.seat, s.y, now);
      return true;
    }
    if (now < c.deadline) return true;
    this.letThrough(c.seat); // no save: on through the line, this very tick
    return false;
  }

  /** No paddle: the ball carries on through the face to the goal line. */
  private letThrough(seat: Seat) {
    this.contact = null;
    this.passed = seat;
  }

  /** A hit. The angle, speed and spin rules are the original ones. */
  private strike(seat: Seat, paddleY: number, now: number) {
    const c = this.contact!;
    const speed = Math.hypot(this.gameState.ballVelocityX, this.gameState.ballVelocityY);
    const hitPosition = Math.max(-1, Math.min(1, (c.crossY - paddleY) / (GAME_CONFIG.PADDLE_HEIGHT / 2)));
    const isPerfectHit = Math.abs(hitPosition) <= 0.15; // centre 30%: double speed-up
    const isEdgeHit = Math.abs(hitPosition) >= 0.7; // outer 30%: sharp angle
    const dir = seat === 1 ? 1 : -1;
    const side: 'left' | 'right' = seat === 1 ? 'left' : 'right';

    this.gameState.ballVelocityX = dir * Math.abs(this.gameState.ballVelocityX);
    let spinStrength = speed >= 10 ? 1.05 : 1.575;
    if (isEdgeHit) spinStrength *= 1.8;
    this.gameState.ballVelocityY += hitPosition * spinStrength;
    const MAX_Y_VELOCITY = speed >= 10 ? 8 : 10;
    this.gameState.ballVelocityY = Math.max(-MAX_Y_VELOCITY, Math.min(MAX_Y_VELOCITY, this.gameState.ballVelocityY));
    if (Math.abs(this.gameState.ballVelocityX) < speed) this.gameState.ballVelocityX = dir * speed;

    this.speedUpBall();
    if (isPerfectHit) this.speedUpBall();
    const power = this.powerHitPlayer === seat;
    if (power) {
      this.speedUpBall();
      this.speedUpBall();
      this.speedUpBall();
      this.powerHitPlayer = null;
    }

    // BEAR CURVE: the swing through the ball
    this.ballSpin = spinFromSwing(this.swingVelocity(seat), RANKED_CURVE);
    this.ballAge = 0;
    this.passed = null;

    if (isEdgeHit) {
      this.sendToPlayer(this.player1.ws, { type: 'edge_hit', side, hitPosition });
      this.sendToPlayer(this.player2.ws, { type: 'edge_hit', side, hitPosition });
    }
    const hit = {
      type: 'paddle_hit' as const,
      side,
      hitPosition,
      perfect: isPerfectHit,
      edge: isEdgeHit,
      power,
      spin: this.ballSpin,
      x: c.face,
      y: c.crossY,
      late: now - c.since,
    };
    // protocol 2 only: an old client would log every unknown message it gets
    if (this.v2(1)) this.sendToPlayer(this.player1.ws, hit);
    if (this.v2(2)) this.sendToPlayer(this.player2.ws, hit);

    // hit-stop: the ball sticks to the face for a beat (a late hit has
    // already been sitting there - it is never held longer for being late)
    c.hitAt = now;
    c.releaseAt = Math.max(now, c.since + (isPerfectHit || isEdgeHit || power ? BIG_HITSTOP_MS : HITSTOP_MS));
    this.gameState.ballX = c.face;
    this.gameState.ballY = c.crossY;
  }

  /**
   * The defender's swing at contact, px per 60Hz tick, from their OWN
   * timestamps (arrival times are bunched by the network; the client's clock
   * says when the paddle was actually there).
   */
  private swingVelocity(seat: Seat): number {
    const s = this.samples[seat];
    if (s.length < 2) return 0;
    const last = s[s.length - 1];
    for (let i = s.length - 2; i >= 0; i--) {
      const dt = last.ct - s[i].ct;
      if (dt >= 30) {
        if (dt > 160) return 0; // the paddle has been still
        return ((last.y - s[i].y) / dt) * (1000 / 60);
      }
    }
    return 0;
  }

  private scoreFor(seat: Seat) {
    if (seat === 2) this.gameState.score2++;
    else this.gameState.score1++;
    console.log(`🎯 Player ${seat} scored! Score: ${this.gameState.score1} - ${this.gameState.score2}`);

    this.player1UsedUltimates.clear();
    this.player2UsedUltimates.clear();
    this.sendToPlayer(this.player1.ws, { type: 'powerups_refreshed' });
    this.sendToPlayer(this.player2.ws, { type: 'powerups_refreshed' });

    const score = seat === 2 ? this.gameState.score2 : this.gameState.score1;
    if (score >= GAME_CONFIG.WINNING_SCORE) {
      this.endGame(seat === 2 ? 'right' : 'left');
      return;
    }
    this.startScoreCountdown();
  }

  /** Increase ball speed up to max AND shrink paddles (cosmetic) progressively. */
  private speedUpBall() {
    const currentSpeed = Math.hypot(this.gameState.ballVelocityX, this.gameState.ballVelocityY);
    if (currentSpeed < GAME_CONFIG.MAX_BALL_SPEED) {
      const k = 1 + GAME_CONFIG.BALL_SPEED_INCREMENT;
      const newVelX = this.gameState.ballVelocityX * k;
      const newVelY = this.gameState.ballVelocityY * k;
      if (Math.hypot(newVelX, newVelY) <= GAME_CONFIG.MAX_BALL_SPEED) {
        this.gameState.ballVelocityX = newVelX;
        this.gameState.ballVelocityY = newVelY;
      } else {
        const angle = Math.atan2(this.gameState.ballVelocityY, this.gameState.ballVelocityX);
        this.gameState.ballVelocityX = Math.cos(angle) * GAME_CONFIG.MAX_BALL_SPEED;
        this.gameState.ballVelocityY = Math.sin(angle) * GAME_CONFIG.MAX_BALL_SPEED;
      }
    }
    this.gameState.paddle1Height = Math.max(GAME_CONFIG.MIN_PADDLE_HEIGHT, this.gameState.paddle1Height - GAME_CONFIG.PADDLE_SHRINK_PER_HIT);
    this.gameState.paddle2Height = Math.max(GAME_CONFIG.MIN_PADDLE_HEIGHT, this.gameState.paddle2Height - GAME_CONFIG.PADDLE_SHRINK_PER_HIT);
  }

  /** 🎉 3-2-1-GO after each goal (the ball waits on the line meanwhile). */
  private startScoreCountdown() {
    this.isPaused = true;
    this.contact = null;
    this.scoreCountdown = 3;
    this.sendToPlayer(this.player1.ws, { type: 'countdown', count: this.scoreCountdown });
    this.sendToPlayer(this.player2.ws, { type: 'countdown', count: this.scoreCountdown });

    this.scoreCountdownInterval = setInterval(() => {
      if (this.ended) return this.clearScoreCountdown();
      this.scoreCountdown--;
      if (this.scoreCountdown > 0) {
        this.sendToPlayer(this.player1.ws, { type: 'countdown', count: this.scoreCountdown });
        this.sendToPlayer(this.player2.ws, { type: 'countdown', count: this.scoreCountdown });
      } else {
        this.sendToPlayer(this.player1.ws, { type: 'countdown', count: 0 });
        this.sendToPlayer(this.player2.ws, { type: 'countdown', count: 0 });
        this.clearScoreCountdown();
        this.resetBall();
        this.isPaused = false;
      }
    }, 1000);
  }

  private clearScoreCountdown() {
    if (this.scoreCountdownInterval) {
      clearInterval(this.scoreCountdownInterval);
      this.scoreCountdownInterval = null;
    }
  }

  private resetBall() {
    this.gameState.ballX = GAME_CONFIG.CANVAS_WIDTH / 2;
    this.gameState.ballY = GAME_CONFIG.CANVAS_HEIGHT / 2;
    this.prevBallX = this.gameState.ballX;
    this.prevBallY = this.gameState.ballY;
    const angle = (Math.random() * Math.PI / 2) - Math.PI / 4; // -45 to 45 degrees
    const direction = Math.random() > 0.5 ? 1 : -1;
    this.gameState.ballVelocityX = Math.cos(angle) * GAME_CONFIG.INITIAL_BALL_SPEED * direction;
    this.gameState.ballVelocityY = Math.sin(angle) * GAME_CONFIG.INITIAL_BALL_SPEED;
    this.ballSpin = 0;
    this.ballAge = 0;
    this.passed = null;
    this.contact = null;
  }

  private endGame(winner: 'left' | 'right') {
    console.log(`🏆 Game over! Winner: ${winner}`);
    this.ended = true;
    this.stopLoops();
    const message = {
      type: 'game_over' as const,
      winner,
      finalScore: { left: this.gameState.score1, right: this.gameState.score2 },
      betAmount: this.finalBetAmount,
    };
    // the final score first, then the result (old clients read either order)
    this.broadcastGameState();
    this.sendToPlayer(this.player1.ws, message);
    this.sendToPlayer(this.player2.ws, message);
  }

  private clampPaddle(y: number): number {
    return Math.max(GAME_CONFIG.PADDLE_HEIGHT / 2, Math.min(GAME_CONFIG.CANVAS_HEIGHT - GAME_CONFIG.PADDLE_HEIGHT / 2, y));
  }

  /** A paddle position arrived (y is the paddle's centre). */
  updatePaddlePosition(playerWs: WebSocket, y: number, timestamp?: number) {
    const seat = this.seatOf(playerWs);
    if (!seat || !Number.isFinite(y)) return;
    const clampedY = this.clampPaddle(y);
    if (seat === 1) this.gameState.paddle1Y = clampedY;
    else this.gameState.paddle2Y = clampedY;

    const at = Date.now();
    const list = this.samples[seat];
    const ct = Number.isFinite(timestamp) ? Number(timestamp) : at;
    // client clocks only ever move forward for one client; ignore a regression
    list.push({ at, ct: list.length && ct < list[list.length - 1].ct ? list[list.length - 1].ct : ct, y: clampedY });
    while (list.length > 2 && at - list[0].at > SAMPLE_MEMORY_MS) list.shift();
  }

  private broadcastGameState() {
    this.gameState.ballSpin = this.ballSpin;
    this.gameState.hold = !!this.contact;
    const message = { type: 'game_state' as const, state: this.gameState };
    this.sendToPlayer(this.player1.ws, message);
    this.sendToPlayer(this.player2.ws, message);
  }

  private sendToPlayer(ws: WebSocket, message: any) {
    try {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    } catch (error) {
      console.error('Error sending message to player:', error);
    }
  }

  /**
   * A player left. A deliberate `leave` AFTER the match is over (results
   * screen, back to the park) tells nobody - but a leave or a drop while
   * the match is still running always tells the rival, who has won.
   */
  handleDisconnect(playerWs: WebSocket, isGracefulLeave: boolean = false) {
    const midMatch = this.started && !this.ended;
    console.log(`👋 Player ${isGracefulLeave ? 'left' : 'disconnected'}${midMatch ? ' mid-match' : ''}`);
    const wasEnded = this.ended;
    this.ended = true;
    this.stopLoops();
    if (!wasEnded && (!isGracefulLeave || midMatch)) {
      const otherPlayer = playerWs === this.player1.ws ? this.player2 : this.player1;
      this.sendToPlayer(otherPlayer.ws, { type: 'opponent_disconnected' });
    }
  }

  private stopLoops() {
    if (this.gameLoop) {
      clearInterval(this.gameLoop);
      this.gameLoop = null;
    }
    if (this.pingLoop) {
      clearInterval(this.pingLoop);
      this.pingLoop = null;
    }
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    if (this.bettingTimer) {
      clearTimeout(this.bettingTimer);
      this.bettingTimer = null;
    }
    this.clearScoreCountdown();
  }

  cleanup() {
    this.stopLoops();
  }

  getPlayers() {
    return [this.player1.ws, this.player2.ws];
  }
}

/**
 * BEARpark Pong Multiplayer Server
 * Handles WebSocket connections, matchmaking, and game sessions
 */
import { WebSocketServer, WebSocket } from 'ws';
import { GameSession } from './GameSession.js';
import type { ClientMessage, PlayerData } from './types.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8080;

// Store for matchmaking queue
const matchmakingQueue: Array<{ ws: WebSocket; data: PlayerData }> = [];

// Active game sessions
const activeSessions = new Map<WebSocket, GameSession>();

// Create WebSocket server
const wss = new WebSocketServer({ port: PORT });

console.log(`🎮 BEARpark Pong Server started on port ${PORT}`);

/**
 * Handle new WebSocket connection
 */
wss.on('connection', (ws: WebSocket) => {
  console.log('🔌 New client connected');

  ws.on('message', (data: Buffer) => {
    try {
      const message: ClientMessage = JSON.parse(data.toString());
      handleClientMessage(ws, message);
    } catch (error) {
      console.error('❌ Error parsing message:', error);
      sendToClient(ws, { type: 'error', message: 'Invalid message format' });
    }
  });

  ws.on('close', () => {
    console.log('👋 Client disconnected');
    handleDisconnect(ws);
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
    handleDisconnect(ws);
  });
});

/**
 * Handle messages from clients
 */
function handleClientMessage(ws: WebSocket, message: ClientMessage) {
  switch (message.type) {
    case 'join_queue':
      handleJoinQueue(ws, message.data);
      break;

    case 'paddle_move':
      handlePaddleMove(ws, message.y);
      break;

    case 'leave':
      handleLeave(ws);
      break;

    case 'ready':
      // Could be used for "ready up" mechanic before countdown
      break;

    case 'rematch':
      // TODO: Implement rematch functionality
      break;

    default:
      console.log('⚠️ Unknown message type:', (message as any).type);
  }
}

/**
 * Handle player joining the matchmaking queue
 */
function handleJoinQueue(ws: WebSocket, playerData: PlayerData) {
  console.log(`🎯 Player joining queue: ${playerData.displayName} (${playerData.wallet})`);

  // Check if player is already in queue
  const alreadyInQueue = matchmakingQueue.some(p => p.ws === ws);
  if (alreadyInQueue) {
    console.log('⚠️ Player already in queue');
    return;
  }

  // Check if player is already in a game
  if (activeSessions.has(ws)) {
    console.log('⚠️ Player already in a game');
    return;
  }

  // Add to queue
  matchmakingQueue.push({ ws, data: playerData });

  // Send queue position
  sendToClient(ws, {
    type: 'queue_joined',
    position: matchmakingQueue.length,
  });

  console.log(`📊 Queue size: ${matchmakingQueue.length}`);

  // Try to match players
  tryMatchmaking();
}

/**
 * Try to create matches from the queue
 */
function tryMatchmaking() {
  while (matchmakingQueue.length >= 2) {
    // Get first two players in queue
    const player1 = matchmakingQueue.shift()!;
    const player2 = matchmakingQueue.shift()!;

    console.log(`🎮 Match found! ${player1.data.displayName} vs ${player2.data.displayName}`);

    // Notify players of match
    sendToClient(player1.ws, {
      type: 'match_found',
      opponent: player2.data,
      yourSide: 'left',
    });

    sendToClient(player2.ws, {
      type: 'match_found',
      opponent: player1.data,
      yourSide: 'right',
    });

    // Create game session
    const session = new GameSession(player1, player2);
    activeSessions.set(player1.ws, session);
    activeSessions.set(player2.ws, session);

    // Start game after a short delay
    setTimeout(() => {
      session.start();
    }, 1000);
  }
}

/**
 * Handle paddle movement
 */
function handlePaddleMove(ws: WebSocket, y: number) {
  const session = activeSessions.get(ws);
  if (session) {
    session.updatePaddlePosition(ws, y);
  }
}

/**
 * Handle player leaving
 */
function handleLeave(ws: WebSocket) {
  console.log('👋 Player requested to leave');
  handleDisconnect(ws);
}

/**
 * Handle player disconnect
 */
function handleDisconnect(ws: WebSocket) {
  // Remove from queue if present
  const queueIndex = matchmakingQueue.findIndex(p => p.ws === ws);
  if (queueIndex !== -1) {
    matchmakingQueue.splice(queueIndex, 1);
    console.log(`📊 Removed from queue. New queue size: ${matchmakingQueue.length}`);
  }

  // Handle disconnect in active game
  const session = activeSessions.get(ws);
  if (session) {
    session.handleDisconnect(ws);

    // Remove both players from active sessions
    const players = session.getPlayers();
    players.forEach(playerWs => {
      activeSessions.delete(playerWs);
    });

    session.cleanup();
    console.log('🎮 Game session ended due to disconnect');
  }
}

/**
 * Send message to client
 */
function sendToClient(ws: WebSocket, message: any) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  } catch (error) {
    console.error('❌ Error sending message to client:', error);
  }
}

/**
 * Graceful shutdown
 */
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');

  wss.close(() => {
    console.log('✅ WebSocket server closed');
    process.exit(0);
  });

  // Force close after 10 seconds
  setTimeout(() => {
    console.error('⚠️ Forcing shutdown...');
    process.exit(1);
  }, 10000);
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully...');

  wss.close(() => {
    console.log('✅ WebSocket server closed');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('⚠️ Forcing shutdown...');
    process.exit(1);
  }, 10000);
});

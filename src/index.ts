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
async function handleClientMessage(ws: WebSocket, message: ClientMessage) {
  switch (message.type) {
    case 'join_queue':
      await handleJoinQueue(ws, message.data);
      break;

    case 'paddle_move':
      handlePaddleMove(ws, message.y);
      break;

    case 'set_bet':
      handleSetBet(ws, message.amount);
      break;

    case 'ready_to_start':
      handleReadyToStart(ws);
      break;

    case 'use_ultimate':
      handleUseUltimate(ws, message.abilityType);
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
 * Fetch player profile including avatar from BEARpark API
 */
async function fetchPlayerProfile(walletAddress: string) {
  try {
    const response = await fetch(`https://bearpark.xyz/api/profile/${walletAddress}`);
    const data = await response.json() as any;

    if (data.success && data.profile) {
      let avatarUrl = null;

      // Parse avatar_nft JSON to get the imageUrl
      if (data.profile.avatar_nft) {
        try {
          const avatarData = JSON.parse(data.profile.avatar_nft);
          avatarUrl = avatarData.imageUrl || avatarData.fallbackImageUrl || null;
        } catch (e) {
          // If not JSON, try using it directly as NFT ID
          avatarUrl = `https://nft.xrpl-labs.com/${data.profile.avatar_nft}`;
        }
      }

      return { avatarUrl };
    }

    console.log(`⚠️ Failed to fetch profile for ${walletAddress}`);
    return { avatarUrl: null };
  } catch (error) {
    console.error(`❌ Error fetching profile for ${walletAddress}:`, error);
    return { avatarUrl: null };
  }
}

/**
 * Fetch equipped cosmetics from BEARpark API
 */
async function fetchEquippedCosmetics(walletAddress: string) {
  try {
    const response = await fetch(`https://www.bearpark.xyz/api/cosmetics/equipped/${walletAddress}`);
    const data = await response.json() as any;

    if (data.success) {
      console.log(`✅ Fetched cosmetics for ${walletAddress}:`, data.equipped);
      return data.equipped;
    }

    console.log(`⚠️ Failed to fetch cosmetics for ${walletAddress}:`, data);
    return { ring: null, banner: null };
  } catch (error) {
    console.error(`❌ Error fetching cosmetics for ${walletAddress}:`, error);
    return { ring: null, banner: null };
  }
}

/**
 * Handle player joining the matchmaking queue
 */
async function handleJoinQueue(ws: WebSocket, playerData: PlayerData) {
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

  // Fetch player profile (including avatar)
  const profile = await fetchPlayerProfile(playerData.wallet);
  if (profile.avatarUrl) {
    playerData.avatarUrl = profile.avatarUrl;
    console.log(`🖼️ Loaded avatar for ${playerData.displayName}: ${profile.avatarUrl.substring(0, 50)}...`);
  }

  // Fetch equipped cosmetics
  const equippedCosmetics = await fetchEquippedCosmetics(playerData.wallet);
  playerData.equippedCosmetics = equippedCosmetics;

  console.log(`✨ Loaded cosmetics for ${playerData.displayName}:`, {
    ring: equippedCosmetics.ring?.name || 'None',
    banner: equippedCosmetics.banner?.name || 'None'
  });

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
    console.log(`🖼️ Player 1 avatar: ${player1.data.avatarUrl?.substring(0, 50) || 'NONE'}`);
    console.log(`🖼️ Player 2 avatar: ${player2.data.avatarUrl?.substring(0, 50) || 'NONE'}`);

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

    // Start betting lobby (30-second timer)
    setTimeout(() => {
      session.startBettingLobby();
    }, 1000);
  }
}

/**
 * 💰 BETTING: Handle player setting their bet
 */
function handleSetBet(ws: WebSocket, amount: number) {
  const session = activeSessions.get(ws);
  if (session) {
    session.handleSetBet(ws, amount);
  }
}

/**
 * 💰 BETTING: Handle player clicking READY
 */
function handleReadyToStart(ws: WebSocket) {
  const session = activeSessions.get(ws);
  if (session) {
    session.handleReadyToStart(ws);
  }
}

/**
 * 🚀 ULTIMATE ABILITIES: Handle player using an ultimate ability
 */
function handleUseUltimate(ws: WebSocket, abilityType: string) {
  const session = activeSessions.get(ws);
  if (session) {
    session.handleUseUltimate(ws, abilityType as any);
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

/**
 * BEARpark Pong Multiplayer Server
 * Handles WebSocket connections, and hands everything between "connected"
 * and "playing" to the Lobby (lobby.ts): presence, the skill-matched queue,
 * accept / decline, private rooms, rematches and emotes. A match itself is a
 * GameSession.
 *
 * Protocol 1 and 2 clients keep working unchanged; protocol 3 clients send
 * `hello` and get the lobby's extras.
 */
import { WebSocketServer, WebSocket } from 'ws';
import { cleanPlayer, Lobby } from './lobby.js';
import { type ClientMessage, type PlayerData } from './types.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8080;
/** a message bigger than this is not a pong message */
const MAX_MESSAGE_BYTES = 8 * 1024;

const wss = new WebSocketServer({ port: PORT, maxPayload: 64 * 1024 });

console.log(`🎮 BEARpark Pong Server started on port ${PORT}`);

const lobby = new Lobby({
  send: sendToClient,
  open: (ws) => ws.readyState === WebSocket.OPEN,
});
setInterval(() => lobby.tick(), 500);

/**
 * Handle new WebSocket connection
 */
wss.on('connection', (ws: WebSocket) => {
  lobby.connect(ws);

  ws.on('message', (data: Buffer) => {
    if (data.length > MAX_MESSAGE_BYTES) return;
    let message: ClientMessage;
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      sendToClient(ws, { type: 'error', message: 'Invalid message format' });
      return;
    }
    try {
      void handleClientMessage(ws, message);
    } catch (error) {
      console.error('❌ Error handling message:', error);
    }
  });

  ws.on('close', () => lobby.disconnect(ws));
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
    lobby.disconnect(ws);
  });
});

/**
 * Handle messages from clients
 */
async function handleClientMessage(ws: WebSocket, message: ClientMessage) {
  if (!message || typeof message !== 'object') return;
  switch (message.type) {
    // ---------------------------------------------------------------- lobby
    case 'hello':
      lobby.hello(ws, message.protocol);
      break;

    case 'join_queue': {
      const data = await enrich(message.data);
      if (ws.readyState === WebSocket.OPEN) lobby.joinQueue(ws, data);
      break;
    }

    case 'leave_queue':
      lobby.leaveQueue(ws);
      break;

    case 'create_room': {
      const data = await enrich(message.data);
      if (ws.readyState === WebSocket.OPEN) lobby.createRoom(ws, data, message.winScore);
      break;
    }

    case 'join_room': {
      const data = await enrich(message.data);
      if (ws.readyState === WebSocket.OPEN) lobby.joinRoom(ws, message.code, data);
      break;
    }

    case 'leave_room':
      lobby.leaveRoom(ws);
      break;

    // ------------------------------------------------------- before a match
    case 'ready_to_start':
      lobby.accept(ws);
      break;

    case 'decline_match':
      lobby.decline(ws);
      break;

    case 'set_bet':
      // betting is retired; kept so an old client's flow still completes
      lobby.sessionOf(ws)?.handleSetBet(ws, Number(message.amount) || 0);
      break;

    // ---------------------------------------------------------- in a match
    case 'paddle_move':
      lobby.sessionOf(ws)?.updatePaddlePosition(ws, Number(message.y), message.timestamp);
      break;

    case 'pong':
      lobby.sessionOf(ws)?.handlePong(ws, message.t);
      break;

    case 'use_ultimate':
      lobby.sessionOf(ws)?.handleUseUltimate(ws, message.abilityType);
      break;

    case 'emote':
      lobby.emote(ws, message.id);
      break;

    // ---------------------------------------------------------- after a match
    case 'rematch':
      lobby.rematch(ws);
      break;

    case 'leave':
      // graceful: out of the queue, the room and the match - the socket stays
      lobby.disconnect(ws, true);
      break;

    case 'ready':
      break;

    default:
      console.log('⚠️ Unknown message type:', (message as any).type);
  }
}

/**
 * A player's card for the rival: what their client says, cleaned, plus the
 * avatar and cosmetics BEARpark has on file for their wallet.
 */
async function enrich(raw: unknown): Promise<PlayerData> {
  const data = cleanPlayer(raw);
  if (data.wallet.startsWith('guest_')) return data;
  const [profile, cosmetics] = await Promise.all([fetchPlayerProfile(data.wallet), fetchEquippedCosmetics(data.wallet)]);
  if (profile.avatarUrl) data.avatarUrl = profile.avatarUrl;
  data.equippedCosmetics = cosmetics;
  return data;
}

/** a profile lookup that takes longer than this is skipped, not waited for */
const LOOKUP_TIMEOUT_MS = 2500;

async function getJson(url: string): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: ctrl.signal });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch player profile including avatar from BEARpark API
 */
async function fetchPlayerProfile(walletAddress: string) {
  try {
    const data = await getJson(`https://bearpark.xyz/api/profile/${encodeURIComponent(walletAddress)}`);
    if (data?.success && data.profile) {
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
    return { avatarUrl: null };
  } catch (error) {
    console.error(`❌ Error fetching profile for ${walletAddress}:`, (error as Error).message);
    return { avatarUrl: null };
  }
}

/**
 * Fetch equipped cosmetics from BEARpark API
 */
async function fetchEquippedCosmetics(walletAddress: string) {
  try {
    const data = await getJson(`https://www.bearpark.xyz/api/cosmetics/equipped/${encodeURIComponent(walletAddress)}`);
    if (data?.success) return data.equipped;
    return { ring: null, banner: null };
  } catch (error) {
    console.error(`❌ Error fetching cosmetics for ${walletAddress}:`, (error as Error).message);
    return { ring: null, banner: null };
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
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`🛑 ${signal} received, shutting down gracefully...`);
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
}

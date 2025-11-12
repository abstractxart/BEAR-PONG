# BEARpark Pong Server

Multiplayer WebSocket server for the BEARpark Pong game.

## Features

- 🎮 Real-time multiplayer Pong gameplay
- 🔄 Automatic matchmaking (pairs players in queue)
- ⚡ Server-authoritative physics (prevents cheating)
- 🏆 First to 3 points wins
- 📊 60 FPS game tick rate

## Local Development

### Prerequisites
- Node.js 18+ installed

### Setup

1. Install dependencies:
```bash
npm install
```

2. Run development server:
```bash
npm run dev
```

Server will start on port 8080 (or PORT environment variable).

### Build for Production

```bash
npm run build
npm start
```

## Deployment to Railway

### Option 1: Railway CLI

1. Install Railway CLI:
```bash
npm install -g @railway/cli
```

2. Login to Railway:
```bash
railway login
```

3. Initialize project:
```bash
railway init
```

4. Deploy:
```bash
railway up
```

### Option 2: GitHub Integration

1. Push this code to a GitHub repository
2. Go to [railway.app](https://railway.app)
3. Click "New Project" → "Deploy from GitHub repo"
4. Select your repository
5. Railway will auto-detect the Node.js app and deploy

### Configuration

Railway will automatically set the `PORT` environment variable. No additional configuration needed!

### Getting WebSocket URL

After deployment, Railway will provide a URL like:
```
wss://your-project.railway.app
```

Use this URL in your Pong client configuration.

## Project Structure

```
src/
├── index.ts         # WebSocket server & matchmaking
├── GameSession.ts   # Game physics & state management
└── types.ts         # Shared type definitions
```

## WebSocket API

### Client → Server Messages

```typescript
// Join matchmaking queue
{ type: 'join_queue', data: { wallet, displayName, avatarUrl } }

// Move paddle
{ type: 'paddle_move', y: number, timestamp: number }

// Leave game
{ type: 'leave' }
```

### Server → Client Messages

```typescript
// Queue joined
{ type: 'queue_joined', position: number }

// Match found
{ type: 'match_found', opponent: PlayerData, yourSide: 'left' | 'right' }

// Countdown before game starts
{ type: 'countdown', count: number }

// Game state update (60 FPS)
{ type: 'game_state', state: GameState }

// Game over
{ type: 'game_over', winner: 'left' | 'right', finalScore: { left, right } }

// Opponent disconnected
{ type: 'opponent_disconnected' }
```

## Testing

Connect with a WebSocket client:

```javascript
const ws = new WebSocket('ws://localhost:8080');

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'join_queue',
    data: {
      wallet: 'rTestWallet123',
      displayName: 'Test Player',
      avatarUrl: 'https://example.com/avatar.jpg'
    }
  }));
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log('Received:', message);
};
```

## License

Part of the BEARpark ecosystem

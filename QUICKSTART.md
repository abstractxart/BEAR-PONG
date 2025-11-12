# BEAR PONG - Quick Start Guide

## 🚀 Get Running in 5 Minutes

### Step 1: Install Dependencies

```bash
npm install
```

### Step 2: Run Locally

```bash
npm run dev
```

Server starts on `http://localhost:8080` (WebSocket on `ws://localhost:8080`)

### Step 3: Deploy to Railway

#### Using Railway CLI:
```bash
# Install CLI
npm install -g @railway/cli

# Login
railway login

# Initialize project
railway init

# Deploy
railway up
```

#### Using GitHub:
1. Push this folder to GitHub
2. Go to [railway.app](https://railway.app)
3. Click "New Project" → "Deploy from GitHub"
4. Select repository → Deploy!

### Step 4: Get Your WebSocket URL

After deployment, Railway gives you a URL like:
```
https://bear-pong-production.up.railway.app
```

Your WebSocket URL is:
```
wss://bear-pong-production.up.railway.app
```

### Step 5: Configure Client

In your `Flappy BEAR` folder:

1. Create `.env` file:
```env
VITE_PONG_SERVER_URL=wss://bear-pong-production.up.railway.app
```

2. Start client:
```bash
cd ../Flappy\ BEAR
npm run dev
```

3. Open browser:
```
http://localhost:5173/pong.html
```

### Step 6: Test Multiplayer

Open **two browser windows** at the same URL to test matchmaking:
- Window 1 joins queue
- Window 2 joins queue
- Server matches them
- Game starts!

## 🎮 That's It!

You now have a working multiplayer Pong server. Players can compete in real-time matches with wins/losses tracked on the BEARpark leaderboard.

## 📊 Monitor Your Server

View logs in Railway dashboard or CLI:
```bash
railway logs
```

Look for:
- `🎮 BEARpark Pong Server started on port 8080`
- `🔌 New client connected`
- `🎯 Player joining queue: PlayerName`
- `🎮 Match found! Player1 vs Player2`

## 🐛 Troubleshooting

**Can't connect?**
- Make sure server is running
- Check Railway logs for errors
- Verify WebSocket URL in client `.env`

**No match found?**
- You need 2 players to start a match
- Open game in 2 browser tabs to test

**Profile pictures not showing?**
- Pass `avatar_url` parameter in URL
- Check browser console for image load errors

## 📖 Full Documentation

See [README.md](./README.md) for complete server documentation.

See [../Flappy BEAR/PONG_IMPLEMENTATION.md](../Flappy%20BEAR/PONG_IMPLEMENTATION.md) for full implementation guide.

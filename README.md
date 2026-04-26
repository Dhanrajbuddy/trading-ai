# Algorithmic Trading AI System

A production-ready, fully Dockerized algorithmic trading assistant for NSE (India) markets.  
It connects to the **Zerodha Kite API** for live data, runs a multi-factor signal engine, manages risk automatically, and executes trades — optionally with full auto-trading support.

> Works with **mock data out of the box** — no API keys needed to run locally.

---

## Features

- **Live market data** — Zerodha Kite API for real-time NSE quotes (47 Nifty 50 stocks)
- **Dynamic stock universe** — Top 20 most active stocks refreshed every 5 minutes from a 47-stock pool
- **Intelligent signal engine** — 5-condition scoring system (0–100 pts): EMA-20, VWAP, RSI-14, Volume quality, Market breadth
- **Risk management** — Fixed fractional position sizing (default 1% risk per trade, configurable)
- **Dynamic Stop Loss** — Swing high/low (10-candle lookback) or ATR × 1.5 fallback, hard-capped at 3%
- **OCO automation** — One Cancels Other bracket monitoring via cron
- **Auto trading** — 7-gate safety system; disabled by default
- **Telegram alerts** — BUY/SELL signals, order confirmations, market summaries
- **React dashboard** — Live signals, stock table, top movers, manual scan trigger
- **Full Docker setup** — One command to start everything

---

## Architecture

```
Zerodha Kite API (or Mock Data)
         │
         ▼
  Dynamic Universe (47 stocks → top 20 active)
         │
         ▼
  Market Scanner  ──────────────────────────────────────┐
  (EMA cross, VWAP breakout, volume spike, gainers)     │
         │                                              │
         ▼                                              │
  Signal Engine (5-condition scoring)                   │
  ├── Market breadth (NIFTY breadth %): +20 / +5 pts   │
  ├── VWAP confirmation:                       +15 pts  │
  ├── RSI-14 optimal zone (40–65):             +15 pts  │
  ├── Volume quality (≥2× avg):                +12 pts  │
  └── EMA-20 fresh breakout (gap <3%):         +10 pts  │
         │                                              │
         ▼ (score ≥ 75 → signal fires)                 │
  Risk Manager (1% rule → position size)               │
         │                                              │
         ▼                                              │
  AI Analyzer (OpenAI GPT / mock fallback)             │
         │                                              │
         ▼                                              │
  Telegram Alert ◄─────────────────────────────────────┘
         │
         ▼
  Auto Trader (7 safety gates) ──► Order Service ──► Zerodha Orders API
         │
         ▼
  OCO Monitor (cron, every 5s) ──► SL / Target hit detection
         │
         ▼
  React Frontend Dashboard (port 5173)
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend runtime | Node.js 18 |
| Web framework | Express 4 |
| Frontend | React 18 + Vite 5 + Tailwind CSS 3 |
| Market data | Zerodha Kite Connect API v3 |
| AI analysis | OpenAI GPT (optional) |
| Alerts | Telegram Bot API |
| Scheduling | node-cron |
| Containerization | Docker + Docker Compose |

---

## Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) ≥ 24
- [Docker Compose](https://docs.docker.com/compose/install/) ≥ 2

No Node.js installation needed — everything runs inside containers.

### 1. Clone the repository

```bash
git clone https://github.com/Dhanrajbuddy/trading-ai.git
cd trading-ai
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` with your credentials (see [Environment Variables](#environment-variables) below).  
The app runs fully on mock data without any credentials.

### 3. Start

```bash
docker compose up
```

| Service | URL | Description |
|---|---|---|
| **Frontend** | http://localhost:5173 | React dashboard |
| **Backend API** | http://localhost:3000 | REST API |

---

## Environment Variables

Copy `.env.example` to `.env` and fill in your values. All variables are optional — the system falls back to mock data.

```env
# Server
PORT=3000

# Zerodha Kite API — live NSE market data and order execution
ZERODHA_API_KEY=your_zerodha_api_key
ZERODHA_API_SECRET=your_zerodha_api_secret
ZERODHA_ACCESS_TOKEN=your_zerodha_access_token
ORDER_PRODUCT=MIS                    # MIS (intraday) or CNC (delivery)

# Telegram Bot — signal and order notifications
TELEGRAM_TOKEN=your_telegram_bot_token
CHAT_ID=your_telegram_chat_id

# Risk Management
CAPITAL=100000                       # Capital in INR (default ₹1,00,000)
RISK_PERCENT=1                       # % of capital risked per trade (default 1%)

# OpenAI — AI confidence scoring (mock used if not set)
OPENAI_API_KEY=your_openai_api_key

# Auto Trading — set to true only after testing thoroughly
AUTO_TRADING=false
```

> **Never commit `.env` to version control.** It is listed in `.gitignore`.

---

## API Endpoints

```bash
# Health check
curl http://localhost:3000/health

# All live stock snapshots (up to 47)
curl http://localhost:3000/stocks

# Last 100 BUY/SELL signals (AI-enriched)
curl http://localhost:3000/signals

# Top 5 gainers + top 5 losers
curl http://localhost:3000/top

# Auto-trader state (trades today, traded symbols, enabled status)
curl http://localhost:3000/orders/auto

# Stock universe state (which 20 stocks are currently active)
curl http://localhost:3000/stocks/universe

# Trigger an immediate market scan
curl -X POST http://localhost:3000/scan

# Manually place an order (requires valid credentials)
curl -X POST http://localhost:3000/orders/place \
  -H "Content-Type: application/json" \
  -d '{"symbol":"RELIANCE","action":"BUY","confidence":82}'
```

---

## Signal Engine — Scoring System

Every potential signal is scored out of 100 points before firing:

| Condition | Points |
|---|---|
| Entry gate satisfied (scanner hit) | +20 (base) |
| Market breadth BULLISH (≥60% stocks above EMA-20) | +20 |
| Market breadth NEUTRAL | +5 |
| Price above/below VWAP (BUY/SELL) | +15 |
| RSI-14 in optimal zone (40–65 BUY / 35–60 SELL) | +15 |
| Volume ≥ 3× average | +12 |
| Volume ≥ 2× average | +10 |
| Volume 1.5–2× average | +5 |
| EMA-20 fresh breakout (price within 3% of EMA) | +10 |
| EMA-20 extended breakout (>3% gap) | +3 |

**Minimum score to fire: 75**

- BUY blocked if market is BEARISH (≤40% above EMA-20)
- SELL blocked if market is BULLISH (≥60% above EMA-20)
- 15-minute cooldown per symbol (no repeated signals)
- Trading window: 9:30 AM – 3:15 PM IST only

---

## Auto Trading — Safety Gates

Auto trading is **off by default** (`AUTO_TRADING=false`). When enabled, a signal must pass **all 7 gates** before an order is placed:

1. `AUTO_TRADING=true` in environment
2. NSE market session is open (09:15–15:30 IST, Mon–Fri)
3. Signal confidence ≥ 80
4. Exchange is NSE (not BSE)
5. Auto trades today < 3 (hard daily cap)
6. Symbol not already auto-traded today
7. Computed position size > 0 (risk manager validation)

After all gates pass, the order is further validated by `orderService` (credentials, duplicate prevention, Zerodha API call).

---

## Risk Management

Position sizing uses the **fixed fractional method**:

```
riskAmount   = CAPITAL × (RISK_PERCENT / 100)
riskPerShare = |entry − stopLoss|
positionSize = floor(riskAmount / riskPerShare)
```

Example with defaults (₹1,00,000 capital, 1% risk):
- Max risk per trade: ₹1,000
- Entry ₹500, SL ₹490 → risk/share ₹10 → position size: 100 shares

---

## Dashboard

Open **http://localhost:5173** after starting with Docker Compose.

- **Signals tab** — live BUY (green) / SELL (red) cards with entry, SL, target, confidence bar
- **Stocks tab** — full table: price, change%, VWAP, EMA-20, volume for all active stocks
- **Top Movers tab** — top 5 gainers and top 5 losers
- Auto-refreshes every 5 seconds
- **Scan Now** button triggers an immediate pipeline run

---

## Project Structure

```
trading-ai/
├── src/                              # Backend — Node.js + Express
│   ├── index.js                      # App entry, routes, cron pipeline
│   ├── alerts/
│   │   └── telegramAlert.js          # Telegram notifications (signal, order, OCO, auto-trade)
│   ├── scanners/
│   │   └── marketScanner.js          # EMA cross, VWAP breakout, volume spike, gainers
│   ├── services/
│   │   ├── aiAnalyzer.js             # OpenAI GPT confidence scoring (mock fallback)
│   │   ├── autoTrader.js             # Auto-trading with 7 safety gates
│   │   ├── mockData.js               # Realistic price simulator (47 Nifty stocks)
│   │   ├── orderService.js           # Safe order execution (Zerodha Kite API)
│   │   ├── stockUniverse.js          # Dynamic 47-stock universe, 5-min TTL selection
│   │   ├── zerodhaAuth.js            # Kite session / access token management
│   │   └── zerodhaService.js         # Market data fetch (live or mock)
│   ├── strategies/
│   │   ├── riskManager.js            # Position sizing (1% fixed fractional)
│   │   └── signalEngine.js           # 5-condition scoring, RSI-14, dynamic SL, cooldown
│   └── utils/
│       └── marketStatus.js           # NSE market hours check
├── frontend/                         # React dashboard — Vite + Tailwind CSS
│   ├── src/
│   │   ├── App.jsx                   # Dashboard (Signals / Stocks / Top Movers tabs)
│   │   ├── api.js                    # Backend API client
│   │   ├── main.jsx
│   │   └── index.css
│   ├── Dockerfile
│   ├── package.json
│   └── vite.config.js
├── .env.example                      # Environment variable template (no real values)
├── .gitignore
├── docker-compose.yml                # Backend + frontend services
├── Dockerfile                        # Backend image (node:18-alpine)
└── package.json
```

---

## Zerodha Kite API Setup

1. Log in to [kite.trade](https://kite.trade) → My Apps → Create an app
2. Copy your **API Key** and **API Secret**
3. Generate a daily **Access Token** via the Kite login flow
4. Add to `.env`:
   ```
   ZERODHA_API_KEY=your_api_key
   ZERODHA_API_SECRET=your_api_secret
   ZERODHA_ACCESS_TOKEN=your_access_token
   ```
5. Restart: `docker compose up`

> The Zerodha Access Token expires daily and must be regenerated each trading day.

---

## Telegram Alerts Setup

1. Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot`
2. Copy the **bot token**
3. Get your **chat ID** (use [@userinfobot](https://t.me/userinfobot))
4. Add to `.env`:
   ```
   TELEGRAM_TOKEN=your_bot_token
   CHAT_ID=your_chat_id
   ```

---

## Security Notes

- `.env` is **git-ignored** — never commit it
- `.env.example` contains **only placeholder values** — safe to commit
- Zerodha Access Token must be regenerated daily
- `AUTO_TRADING=false` by default — review all 7 gates before enabling
- All order placement is guarded by both `autoTrader` and `orderService` safety checks

---

## Stop

```bash
docker compose down
```

---

## Future Improvements

- Backtesting engine with historical OHLCV data
- Strategy parameter optimization (grid search / genetic algorithm)
- Portfolio P&L tracking and daily summary reports
- Multi-broker support (Upstox, Angel One)
- WebSocket-based real-time price streaming
- Paper trading mode for strategy validation


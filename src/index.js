'use strict';

require('dotenv').config();

// ─── Pipe console.log / console.error into the in-memory debug log ────────────
// Must run before any other require so all modules benefit automatically.
const { log: _log } = require('./services/logger');

const _origLog   = console.log.bind(console);
const _origError = console.error.bind(console);
const _origWarn  = console.warn.bind(console);

console.log = (...args) => {
  _origLog(...args);
  _log('INFO', args.map(String).join(' '));
};
console.error = (...args) => {
  _origError(...args);
  _log('ERROR', args.map(String).join(' '));
};
console.warn = (...args) => {
  _origWarn(...args);
  _log('INFO', args.map(String).join(' '));
};

const express = require('express');
const cron    = require('node-cron');

const { getMarketData }       = require('./services/zerodhaService');
const { generateAccessToken } = require('./services/zerodhaAuth');
const { placeOrder, getDailyState, getOrderLog, monitorOrders, getOcoTrades } = require('./services/orderService');
const { runScanners }         = require('./scanners/marketScanner');
const { generateSignals }     = require('./strategies/signalEngine');
const { analyzeSignal }       = require('./services/aiAnalyzer');
const { sendAlert, sendMarketAlert }   = require('./alerts/telegramAlert');
const { processSignal, getAutoTradeState } = require('./services/autoTrader');
const { refreshIfStale, forceRefresh, getUniverseState } = require('./services/stockUniverse');
const { marketStatusInfo }           = require('./utils/marketStatus');
const { runBacktest, runPortfolioBacktest } = require('./backtest/backtestEngine');
const { log, getLogs, clearLogs }    = require('./services/logger');

// ─── App Setup ────────────────────────────────────────────────────────────────

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Allow frontend (Vite on 5173) to call the API
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ─── In-memory stores ─────────────────────────────────────────────────────────

/** @type {Array<Object>} */
let latestStocks  = [];
/** @type {Array<Object>} */
let latestSignals = [];
/** @type {boolean} */
let isAuthenticated = false;

// ─── Pipeline ─────────────────────────────────────────────────────────────────

async function runPipeline() {
  const ts = new Date().toISOString();
  console.log(`[Pipeline] Running market scan... (${ts})`);

  // 1. Fetch market data (Zerodha only — no mock fallback)
  let stocks;
  try {
    stocks = await getMarketData();
    isAuthenticated = true;
  } catch (err) {
    if (err.code === 'NOT_AUTHENTICATED') {
      isAuthenticated = false;
      console.log('[Pipeline] Not authenticated — skipping scan. Visit /zerodha/login to connect.');
      latestStocks = [];
      return;
    }
    console.error(`[Pipeline] Market data error: ${err.message}`);
    return;
  }
  latestStocks = stocks;

  // 1a. Dynamic stock selection — refresh every 5 min (force on very first run)
  if (latestStocks.length > 0) {
    refreshIfStale(stocks);   // no-op if cache is still fresh
  }

  // 2. Scan
  const scanData = runScanners(stocks);
  console.log(
    `[Scanner] Gainers:${scanData.topGainers.length} | ` +
    `Spikes:${scanData.volumeSpikes.length} | ` +
    `Breakouts:${scanData.breakouts.length} | ` +
    `VWAP:${scanData.vwapBreakouts.length} | ` +
    `EMA:${scanData.emaCrosses.length}`
  );

  // 3. Signals
  const signals = generateSignals(stocks, scanData);
  console.log(`[Strategy] Actionable signals: ${signals.length}`);

  if (signals.length === 0) {
    console.log('[Strategy] No actionable signals this cycle.');
    return;
  }

  // 4. AI enrich + Telegram
  const enriched = [];
  for (const signal of signals) {
    const analysis = await analyzeSignal(signal);
    console.log(`[AI] ${signal.symbol} ${signal.action} — ${analysis.confidence}% (${analysis.source})`);
    await sendAlert(signal, analysis);
    enriched.push({ ...signal, analysis });
  }

  latestSignals = [...enriched, ...latestSignals].slice(0, 100);
  console.log(`[Pipeline] ✅ ${enriched.length} signal(s) processed.\n`);

  // 5. Auto-trading — each enriched signal is evaluated by autoTrader
  for (const signal of enriched) {
    await processSignal(signal);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status:          'ok',
    service:         'trading-ai',
    timestamp:       new Date().toISOString(),
    uptime:          process.uptime(),
    authenticated:   isAuthenticated,
    stocks:          latestStocks.length,
    signals:         latestSignals.length,
  });
});

// All live stocks
app.get('/stocks', (_req, res) => {
  res.json({ count: latestStocks.length, stocks: latestStocks });
});

// Active BUY/SELL signals (enriched with AI)
app.get('/signals', (_req, res) => {
  res.json({ count: latestSignals.length, signals: latestSignals });
});

// Top movers — top 5 gainers + top 5 losers by changePercent
app.get('/top', (_req, res) => {
  const sorted  = [...latestStocks].sort((a, b) => b.changePercent - a.changePercent);
  const gainers = sorted.slice(0, 5);
  const losers  = sorted.slice(-5).reverse();
  res.json({ gainers, losers });
});

// Manual scan trigger
app.post('/scan', async (_req, res) => {
  try {
    await runPipeline();
    res.json({ status: 'ok', message: 'Scan triggered.' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── Order Routes (MANUAL ONLY — never auto-triggered) ──────────────────────

// POST /orders/place  — place a single order for a given signal
// Body: the full signal object from GET /signals (must include positionSize)
app.post('/orders/place', async (req, res) => {
  const signal = req.body;
  if (!signal || !signal.symbol || !signal.action) {
    return res.status(400).json({
      status: 'error',
      message: 'Request body must be a valid signal object with symbol and action.',
    });
  }
  try {
    const result = await placeOrder(signal);
    const httpStatus = result.status === 'SUCCESS' ? 200 : 400;
    res.status(httpStatus).json(result);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /order/test  — manual execution with lightweight validation
// Body: signal object (confidence, exchange/symbol required)
app.post('/order/test', async (req, res) => {
  const signal = req.body;

  // ── Validation ──────────────────────────────────────────────────────────────
  const confidence = Number(signal?.confidence);
  if (!signal || !signal.symbol || !signal.action) {
    return res.status(400).json({
      success: false,
      message: 'Request body must include symbol and action.',
    });
  }

  if (isNaN(confidence) || confidence < 75) {
    return res.status(400).json({
      success: false,
      message: `Confidence ${confidence}% is below the minimum threshold of 75%.`,
    });
  }

  // exchange must be NSE — accept both "NSE:SYMBOL" and explicit exchange field
  const symbolStr      = String(signal.symbol);
  const hasNSEPrefix   = symbolStr.startsWith('NSE:');
  const exchangeField  = String(signal.exchange || '').toUpperCase();
  const isNSE          = hasNSEPrefix || exchangeField === 'NSE';

  if (!isNSE) {
    return res.status(400).json({
      success: false,
      message: `Exchange must be NSE. Received: "${signal.exchange || symbolStr}".`,
    });
  }

  // ── Execute ─────────────────────────────────────────────────────────────────
  try {
    const result = await placeOrder(signal);
    if (result.status === 'SUCCESS') {
      return res.json({
        success: true,
        message: `Order placed — ${signal.action} ${symbolStr} × ${signal.positionSize ?? '?'} shares`,
        orderId: result.orderId,
      });
    }
    return res.status(400).json({
      success: false,
      message: result.reason || result.message || 'Order rejected by safety gates.',
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /orders/log  — return all order attempts this session
app.get('/orders/log', (_req, res) => {
  res.json({ orders: getOrderLog() });
});

// GET /orders/state  — return today's trade count and remaining allowance
app.get('/orders/state', (_req, res) => {
  res.json(getDailyState());
});

// GET /orders/oco  — active OCO trades being monitored
app.get('/orders/oco', (_req, res) => {
  res.json({ trades: getOcoTrades() });
});

// GET /orders/auto  — auto-trader state (daily counts, flag, settings)
app.get('/orders/auto', (_req, res) => {
  res.json(getAutoTradeState());
});

// GET /stocks/universe  — dynamic stock selection state
app.get('/stocks/universe', (_req, res) => {
  res.json(getUniverseState());
});

// GET /backtest  — replay historical candles through the live strategy
// Query params:
//   symbol  (required) — NSE ticker, e.g. RELIANCE
//   days    (optional) — lookback days, 1–60, default 7
// Example: GET /backtest?symbol=RELIANCE&days=30
app.get('/backtest', async (req, res) => {
  const { symbol, days } = req.query;

  if (!symbol || typeof symbol !== 'string' || !/^[A-Za-z0-9]+$/.test(symbol)) {
    return res.status(400).json({
      status: 'error',
      message: 'Missing or invalid "symbol" query parameter. Example: /backtest?symbol=RELIANCE',
    });
  }

  try {
    const result = await runBacktest(symbol, days);
    res.json(result);
  } catch (err) {
    console.error(`[Backtest] Error: ${err.message}`);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /backtest/portfolio — run backtest across a default portfolio of 7 symbols
// Query params:
//   symbols  (optional) — comma-separated tickers, e.g. RELIANCE,TCS,INFY
//   days     (optional) — lookback days, 1–60, default 7
// Example: GET /backtest/portfolio?days=14
// Example: GET /backtest/portfolio?symbols=RELIANCE,TCS&days=30
app.get('/backtest/portfolio', async (req, res) => {
  const { symbols, days } = req.query;

  let tickers;
  if (symbols) {
    tickers = symbols.split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z0-9]+$/.test(s));
    if (tickers.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid "symbols" parameter. Example: ?symbols=RELIANCE,TCS,INFY',
      });
    }
  }

  try {
    const result = await runPortfolioBacktest(tickers, days);
    res.json(result);
  } catch (err) {
    console.error(`[Portfolio Backtest] Error: ${err.message}`);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── Logger Routes ────────────────────────────────────────────────────────────

app.get('/logs', (req, res) => {
  const { type, limit } = req.query;
  let entries = getLogs();
  if (type) {
    const t = type.toUpperCase();
    entries = entries.filter((e) => e.type === t);
  }
  if (limit) {
    const n = parseInt(limit, 10);
    if (!isNaN(n) && n > 0) entries = entries.slice(-n);
  }
  res.json({ count: entries.length, logs: entries });
});

app.delete('/logs', (_req, res) => {
  clearLogs();
  res.json({ status: 'ok', message: 'Logs cleared' });
});

app.post('/logs/clear', (_req, res) => {
  clearLogs();
  res.json({ status: 'ok', message: 'Logs cleared' });
});

// ─── Zerodha Auth Routes ──────────────────────────────────────────────────────

// Step 1 — Redirect browser to Kite login page
app.get('/zerodha/login', (_req, res) => {
  const apiKey = process.env.ZERODHA_API_KEY;
  if (!apiKey) {
    return res.status(400).send('<h2>&#10060; ZERODHA_API_KEY is not set in .env</h2>');
  }
  const loginUrl = `https://kite.zerodha.com/connect/login?api_key=${apiKey}&v=3`;
  console.log(`[ZerodhaAuth] Redirecting to Kite login: ${loginUrl}`);
  res.redirect(loginUrl);
});

// Step 2 — Kite redirects here with ?request_token=XXX&status=success
app.get('/zerodha/callback', async (req, res) => {
  const { request_token, status } = req.query;

  if (status !== 'success' || !request_token) {
    const msg = `Kite returned status="${status || 'unknown'}" without a request_token.`;
    console.error(`[ZerodhaCallback] ❌ ${msg}`);
    return res.status(400).send(`
      <h2>&#10060; Zerodha Login Failed</h2>
      <p>${msg}</p>
      <p><a href="/zerodha/login">&#8592; Try again</a></p>
    `);
  }

  try {
    const accessToken = await generateAccessToken(request_token);

    console.log(`[ZerodhaAuth] Login successful. Access token acquired.`);

    // Trigger immediate pipeline run using real Kite data
    runPipeline().catch((err) => console.error(`[Callback] Pipeline: ${err.message}`));

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Zerodha Login Success</title>
          <style>
            body { font-family: sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; }
            code { background: #f4f4f4; padding: 4px 8px; border-radius: 4px; word-break: break-all; }
            .btn { display: inline-block; margin-top: 20px; padding: 10px 20px;
                   background: #3b82f6; color: white; text-decoration: none;
                   border-radius: 6px; font-weight: bold; }
          </style>
        </head>
        <body>
          <h2>&#9989; Zerodha Login Successful!</h2>
          <p><strong>Access Token:</strong><br><code>${accessToken}</code></p>
          <p>Token has been saved to <code>.env</code> and is active immediately.</p>
          <p>Real NSE market data is now live &#127381;</p>
          <a class="btn" href="http://localhost:5173">Open Dashboard &rarr;</a>
        </body>
      </html>
    `);
  } catch (err) {
    console.error(`[ZerodhaCallback] ❌ Token generation failed: ${err.message}`);
    res.status(500).send(`
      <h2>&#10060; Token Generation Failed</h2>
      <p>${err.message}</p>
      <p><a href="/zerodha/login">&#8592; Try again</a></p>
    `);
  }
});

// Market session status
app.get('/market/status', (_req, res) => {
  res.json(marketStatusInfo());
});

// ─── Cron ─────────────────────────────────────────────────────────────────────

// Market open alert — 09:15 IST = 03:45 UTC
cron.schedule('45 3 * * 1-5', async () => {
  console.log('[Cron] Market opened. Sending Telegram alert.');
  await sendMarketAlert('open').catch((e) => console.error(`[Cron] Market open alert failed: ${e.message}`));
});

// Market close alert — 15:30 IST = 10:00 UTC
cron.schedule('0 10 * * 1-5', async () => {
  console.log('[Cron] Market closed. Sending Telegram alert.');
  await sendMarketAlert('close').catch((e) => console.error(`[Cron] Market close alert failed: ${e.message}`));
});

// OCO monitor — every 5 seconds (only during market hours to avoid wasted API calls)
cron.schedule('*/5 * * * * *', async () => {
  try {
    await monitorOrders();
  } catch (err) {
    console.error(`[Cron/OCO] Error: ${err.message}`);
  }
});

// Pipeline — every 5 seconds
cron.schedule('*/5 * * * * *', async () => {
  try {
    await runPipeline();
  } catch (err) {
    console.error(`[Cron] Error: ${err.message}`);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[Server] Algorithmic Trading AI v2.0 started on port ${PORT}`);
  runPipeline().catch((err) => console.error(`[Startup] ${err.message}`));
});

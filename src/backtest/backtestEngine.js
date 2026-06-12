'use strict';

/**
 * Backtest Engine — ORB Strategy on 15-min Zerodha Candles
 *
 * Uses IDENTICAL entry/exit logic to signalEngine.js via shared orbCore.js.
 * Requires real Zerodha historical data. Will NOT fall back to synthetic data.
 * Results are persisted to data/backtest-results.json for reproducibility.
 *
 * Entry mirrors live signalEngine.js exactly:
 *   - 2 × 15-min ORB (9:15–9:45 AM IST)
 *   - Breakout above/below ORB ± 0.10% buffer
 *   - Volume spike ≥ 1.5× rolling average
 *   - RSI 45–72 (BUY) / 28–55 (SELL) — required non-null
 *   - Bullish/bearish candle direction
 *   - VWAP gate: price must be above/below VWAP
 *   - Nifty trend filter: SELL suppressed when ≥55% of batch stocks above VWAP
 *   - Entry cutoff: 2:30 PM IST
 *   - Force-close: 3:15 PM IST
 *   - Max 2 trades/day/symbol, 30-min cooldown
 *   - SL: 0.5% fixed from entry
 *   - Target: 2× ORB range (min 1.0% fallback)
 *
 * Run: require this module and call runBacktest(symbol, days) or
 *      runPortfolioBacktest(symbols, days) — both async, both persist results.
 */

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const {
  MIN_CONFIDENCE, VOLUME_SPIKE_MIN, ORB_CANDLES, ORB_BUFFER_PCT, ORB_MIN_RANGE_PCT,
  MAX_TRADES_PER_DAY, COOLDOWN_MINS,
  WINDOW_START_MINS, ENTRY_CUTOFF_MINS, CLOSE_ALL_MINS,
  BULL_MARKET_THRESHOLD,
  calcTradingCosts, computeRSI, scoreSignal, fixedSL, dynamicTarget, getCandleMinsIST,
} = require('../strategies/orbCore');

// ─── Backtest-only config ─────────────────────────────────────────────────────

const CAPITAL           = parseFloat(process.env.CAPITAL) || 20_000;
const CAPITAL_PER_TRADE = Math.floor(CAPITAL * 0.80);  // ₹16k on ₹20k capital
const COOLDOWN_CANDLES  = Math.ceil(COOLDOWN_MINS / 15); // candles equivalent

const RESULTS_PATH = path.resolve(__dirname, '../../data/backtest-results.json');

// ─── Instrument Tokens (NSE Equity — Nifty 50 stable tokens) ─────────────────

const INSTRUMENT_TOKENS = {
  RELIANCE:   738561,  TCS:        2953217, INFY:       408065,
  HDFCBANK:   341249,  ICICIBANK:  1270529, HINDUNILVR: 356865,
  SBIN:       779521,  BHARTIARTL: 2714625, ITC:        424961,
  KOTAKBANK:  492033,  LT:         2939649, AXISBANK:   1510401,
  BAJFINANCE: 4267265, WIPRO:      969473,  ULTRACEMCO: 2952193,
  ASIANPAINT: 60417,   MARUTI:     2815745, SUNPHARMA:  857857,
  TITAN:      897537,  NESTLEIND:  4598529, ADANIENT:   25,
  ADANIPORTS: 3861249, APOLLOHOSP: 157001,  BAJAJFINSV: 4268801,
  BPCL:       134657,  BRITANNIA:  140033,  CIPLA:      177665,
  COALINDIA:  5215745, DIVISLAB:   2800641, DRREDDY:    225537,
  EICHERMOT:  232961,  GRASIM:     315393,  HCLTECH:    1850625,
  HEROMOTOCO: 345089,  HINDALCO:   348929,  INDUSINDBK: 1346049,
  JSWSTEEL:   3001089, LTIM:       17818113,NTPC:       2977281,
  ONGC:       633601,  POWERGRID:  3834113, SHRIRAMFIN: 4220929,
  TATACONSUM: 878593,  TATAMOTORS: 884737,  TATASTEEL:  895745,
  TECHM:      3465729, TRENT:      1964033,
};

// ─── Data Fetching ────────────────────────────────────────────────────────────
//
// NO synthetic fallback. Throws clearly if credentials are missing or API fails.
// Zerodha ACCESS_TOKEN must be refreshed daily — run during market hours or
// after a fresh login to get a valid token.

// calcTradingCosts, computeRSI, scoreSignal, fixedSL, dynamicTarget all imported from orbCore.js

// ─── Zerodha API ─────────────────────────────────────────────────────────────

async function fetchHistoricalCandles(symbol, fromDate, toDate) {
  if (!process.env.ZERODHA_API_KEY || !process.env.ZERODHA_ACCESS_TOKEN) {
    throw new Error(
      'ZERODHA_API_KEY and ZERODHA_ACCESS_TOKEN are required for backtest. ' +
      'The ACCESS_TOKEN must be refreshed daily via Zerodha login. ' +
      'No synthetic fallback is available — results must be based on real data.'
    );
  }
  const token = INSTRUMENT_TOKENS[symbol.toUpperCase()];
  if (!token) {
    throw new Error(`No instrument token for "${symbol}". Add it to INSTRUMENT_TOKENS in backtestEngine.js.`);
  }
  const url = `https://api.kite.trade/instruments/historical/${token}/15minute` +
              `?from=${encodeURIComponent(fromDate + ' 09:00:00')}` +
              `&to=${encodeURIComponent(toDate + ' 15:30:00')}&continuous=0&oi=0`;
  const resp = await axios.get(url, {
    headers: {
      'X-Kite-Version': '3',
      Authorization: `token ${process.env.ZERODHA_API_KEY}:${process.env.ZERODHA_ACCESS_TOKEN}`,
    },
    timeout: 15_000,
  });
  const candles = resp.data?.data?.candles;
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new Error(`No candles returned for ${symbol} (${fromDate} – ${toDate}). Check credentials and date range.`);
  }
  return candles;
}

// ─── Core Replay Engine ───────────────────────────────────────────────────────
//
// Replays 15-min candles using IDENTICAL logic to signalEngine.js.
// All entry conditions, scoring, SL, and target come from orbCore.js.
// Per-symbol state is reset on each new calendar day.
//
// Nifty trend filter: since this is a single-symbol replay, we cannot compute
// market breadth from a snapshot. Instead we approximate: on each candle we
// track a 20-candle rolling fraction of closes above VWAP as a breadth proxy.
// If that fraction >= BULL_MARKET_THRESHOLD, SELL signals are suppressed — exactly
// as the live system would behave when running across the full stock universe.

/**
 * @param {Array}  candles  [[ts, open, high, low, close, volume], ...] 15-min Zerodha candles
 * @param {string} symbol
 * @returns {Array<Object>}  completed trades with full metadata
 */
function replayCandles(candles, symbol) {
  const trades       = [];
  const closeHistory  = [];   // for RSI (sliding window, max 30)
  const volumeHistory = [];   // for volume spike calc (max 20)
  const vwapHistory   = [];   // rolling: was close > vwap? (max 20 candles, breadth proxy)

  let vwapAccum = 0, vwapVol = 0;
  let orbHigh = -Infinity, orbLow = Infinity, orbEstablished = false;
  let currentDay = '', dailyCandleCount = 0, dailyTradeCount = 0, dailyTradeDay = '';
  let lastSignalIdx = -999;
  let openTrade = null;

  for (let i = 0; i < candles.length; i++) {
    const [ts, open, high, low, close, rawVol] = candles[i];
    const volume     = (typeof rawVol === 'number' && isFinite(rawVol) && rawVol > 0) ? rawVol : null;
    const candleMins = getCandleMinsIST(ts);
    const candleDate = ts.slice(0, 10);

    // ── Day boundary reset ───────────────────────────────────────────────────
    if (candleDate !== currentDay) {
      vwapAccum = 0; vwapVol = 0;
      orbHigh = -Infinity; orbLow = Infinity; orbEstablished = false;
      dailyCandleCount = 0;
      currentDay = candleDate;
      if (dailyTradeDay !== candleDate) { dailyTradeCount = 0; dailyTradeDay = candleDate; }

      // Safety net: force-close overnight carry
      if (openTrade) {
        const { action, entry, sl, target, qty, entryTs, entryIdx } = openTrade;
        const gp = action === 'BUY' ? (open - entry) * qty : (entry - open) * qty;
        const cost = calcTradingCosts(action, entry, open, qty);
        trades.push({
          symbol, action,
          entry: parseFloat(entry.toFixed(2)), exit: parseFloat(open.toFixed(2)),
          stopLoss: parseFloat(sl.toFixed(2)), target: parseFloat(target.toFixed(2)),
          qty, grossProfit: parseFloat(gp.toFixed(2)), tradingCost: cost,
          profit: parseFloat((gp - cost).toFixed(2)),
          result: (gp - cost) >= 0 ? 'WIN' : 'LOSS',
          entryTime: entryTs, exitTime: ts, holdCandles: i - entryIdx,
          note: 'overnight-safety-close',
        });
        openTrade = null;
      }
    }

    // ── VWAP ─────────────────────────────────────────────────────────────────
    const tp = (high + low + close) / 3;
    if (volume !== null) { vwapAccum += tp * volume; vwapVol += volume; }
    const vwap = vwapVol > 0 ? vwapAccum / vwapVol : null;

    // ── History updates ──────────────────────────────────────────────────────
    closeHistory.push(close);
    if (closeHistory.length > 30) closeHistory.shift();
    dailyCandleCount++;
    if (volume !== null) { volumeHistory.push(volume); if (volumeHistory.length > 20) volumeHistory.shift(); }

    // Rolling breadth proxy: was this candle's close above VWAP?
    if (vwap !== null) { vwapHistory.push(close > vwap ? 1 : 0); if (vwapHistory.length > 20) vwapHistory.shift(); }

    // ── Opening Range accumulation ───────────────────────────────────────────
    if (!orbEstablished) {
      orbHigh = Math.max(orbHigh, high);
      orbLow  = Math.min(orbLow,  low);
      if (dailyCandleCount >= ORB_CANDLES) {
        orbEstablished = true;
        const pct = ((orbHigh - orbLow) / close * 100).toFixed(2);
        console.log(`[BT:${symbol}] ${candleDate} ORB High=₹${orbHigh.toFixed(2)} Low=₹${orbLow.toFixed(2)} Range=${pct}%`);
      }
      continue;
    }

    // ── Manage open trade ────────────────────────────────────────────────────
    if (openTrade) {
      const { action, entry, sl, target, qty, entryTs, entryIdx } = openTrade;

      if (candleMins >= CLOSE_ALL_MINS) {
        const gp   = action === 'BUY' ? (close - entry) * qty : (entry - close) * qty;
        const cost = calcTradingCosts(action, entry, close, qty);
        trades.push({
          symbol, action,
          entry: parseFloat(entry.toFixed(2)), exit: parseFloat(close.toFixed(2)),
          stopLoss: parseFloat(sl.toFixed(2)), target: parseFloat(target.toFixed(2)),
          qty, grossProfit: parseFloat(gp.toFixed(2)), tradingCost: cost,
          profit: parseFloat((gp - cost).toFixed(2)),
          result: (gp - cost) >= 0 ? 'WIN' : 'LOSS',
          entryTime: entryTs, exitTime: ts, holdCandles: i - entryIdx,
          note: '3:15 PM squareoff',
        });
        openTrade = null; continue;
      }

      const slHit  = (action === 'BUY' && low  <= sl)    || (action === 'SELL' && high >= sl);
      const tgtHit = (action === 'BUY' && high >= target) || (action === 'SELL' && low  <= target);
      if (slHit || tgtHit) {
        const exitPrice = slHit ? sl : target;
        const result    = slHit ? 'LOSS' : 'WIN';
        const gp   = action === 'BUY' ? (exitPrice - entry) * qty : (entry - exitPrice) * qty;
        const cost = calcTradingCosts(action, entry, exitPrice, qty);
        console.log(`[BT:${symbol}] ${ts.slice(0,16).replace('T',' ')} ${result} ${action} exit=₹${exitPrice.toFixed(2)} pnl=₹${(gp-cost).toFixed(0)}`);
        trades.push({
          symbol, action,
          entry: parseFloat(entry.toFixed(2)), exit: parseFloat(exitPrice.toFixed(2)),
          stopLoss: parseFloat(sl.toFixed(2)), target: parseFloat(target.toFixed(2)),
          qty, grossProfit: parseFloat(gp.toFixed(2)), tradingCost: cost,
          profit: parseFloat((gp - cost).toFixed(2)), result,
          entryTime: entryTs, exitTime: ts, holdCandles: i - entryIdx,
        });
        openTrade = null;
      }
      if (openTrade) continue;
    }

    // ── Window / limits guards ────────────────────────────────────────────────
    const inWindow  = candleMins >= WINDOW_START_MINS && candleMins <= ENTRY_CUTOFF_MINS;
    if (!inWindow)                                continue;
    if (dailyTradeCount >= MAX_TRADES_PER_DAY)   continue;
    if (i - lastSignalIdx < COOLDOWN_CANDLES)    continue;
    if ((high - low) / close < 0.002)            continue;  // skip doji/sideways

    // ── Entry conditions (exact match to signalEngine.js) ────────────────────
    const orbRange    = orbHigh - orbLow;
    const orbRangePct = (orbRange / close) * 100;
    if (orbRangePct < ORB_MIN_RANGE_PCT) continue;  // narrow ORB — skip (mirrors signalEngine)

    const orbBufHigh = orbHigh * (1 + ORB_BUFFER_PCT / 100);
    const orbBufLow  = orbLow  * (1 - ORB_BUFFER_PCT / 100);

    const rsi = computeRSI(closeHistory);

    const avgVolume = volumeHistory.length > 1
      ? volumeHistory.slice(0, -1).reduce((s, v) => s + v, 0) / (volumeHistory.length - 1)
      : (volumeHistory[0] ?? 0);
    const vm = (volume !== null && avgVolume > 0) ? parseFloat((volume / avgVolume).toFixed(2)) : null;
    const hasVolumeSpike = vm != null && vm >= VOLUME_SPIKE_MIN;

    const rsiOkBuy  = rsi !== null && rsi >= 45 && rsi <= 72;
    const rsiOkSell = rsi !== null && rsi >= 28 && rsi <= 55;
    const vwapAbove = vwap !== null && close > vwap;
    const vwapBelow = vwap !== null && close < vwap;

    // Nifty trend filter proxy: if last 20 candles were mostly above VWAP, suppress SELL
    const breadthFraction = vwapHistory.length > 0
      ? vwapHistory.reduce((s, v) => s + v, 0) / vwapHistory.length
      : 0.5;
    const isBullMarket = breadthFraction >= BULL_MARKET_THRESHOLD;

    const isBuy  = close > orbBufHigh && close > open && hasVolumeSpike && rsiOkBuy  && vwapAbove;
    const isSell = close < orbBufLow  && close < open && hasVolumeSpike && rsiOkSell && vwapBelow && !isBullMarket;

    if (!isBuy && !isSell) continue;

    const action = isBuy ? 'BUY' : 'SELL';
    const score  = scoreSignal(action, { rsi, volumeMultiplier: vm, price: close, vwap });

    if (score < MIN_CONFIDENCE) {
      console.log(`[BT:${symbol}] rejected score=${score} rsi=${rsi?.toFixed(1)} vm=${vm} close=₹${close}`);
      continue;
    }

    const sl             = fixedSL(action, close);
    const { target }     = dynamicTarget(action, close, orbHigh, orbLow);
    const qty            = Math.floor(CAPITAL_PER_TRADE / close);
    if (qty <= 0) continue;

    const estCost = calcTradingCosts(action, close, target, qty);
    if (Math.abs(target - close) * qty <= estCost) continue;  // position too small to cover costs

    lastSignalIdx = i;
    dailyTradeCount++;
    openTrade = { action, entry: close, sl, target, qty, entryIdx: i, entryTs: ts };
    console.log(`[BT:${symbol}] ${ts.slice(0,16).replace('T',' ')} ${action} entry=₹${close.toFixed(2)} sl=₹${sl} tgt=₹${target} qty=${qty} score=${score} rsi=${rsi?.toFixed(1)} vm=${vm}`);
  }

  // End-of-data force-close
  if (openTrade && candles.length > 0) {
    const [lts, , , , lclose] = candles[candles.length - 1];
    const { action, entry, sl, target, qty, entryTs, entryIdx } = openTrade;
    const gp   = action === 'BUY' ? (lclose - entry) * qty : (entry - lclose) * qty;
    const cost = calcTradingCosts(action, entry, lclose, qty);
    trades.push({
      symbol, action,
      entry: parseFloat(entry.toFixed(2)), exit: parseFloat(lclose.toFixed(2)),
      stopLoss: parseFloat(sl.toFixed(2)), target: parseFloat(target.toFixed(2)),
      qty, grossProfit: parseFloat(gp.toFixed(2)), tradingCost: cost,
      profit: parseFloat((gp - cost).toFixed(2)),
      result: (gp - cost) >= 0 ? 'WIN' : 'LOSS',
      entryTime: entryTs, exitTime: lts, holdCandles: candles.length - 1 - entryIdx,
      note: 'end-of-data force-close',
    });
  }

  return trades;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

function computeMetrics(trades) {
  if (trades.length === 0) {
    return { totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0,
             totalProfit: 0, totalCosts: 0, maxDrawdown: 0, avgRiskReward: 0,
             equityCurve: [], dailyStats: [] };
  }
  const wins   = trades.filter((t) => t.result === 'WIN');
  const losses = trades.filter((t) => t.result === 'LOSS');

  const totalProfit = parseFloat(trades.reduce((s, t) => s + t.profit,       0).toFixed(2));
  const totalCosts  = parseFloat(trades.reduce((s, t) => s + (t.tradingCost || 0), 0).toFixed(2));

  let peak = 0, cumPnL = 0, drawdown = 0;
  for (const t of trades) {
    cumPnL += t.profit;
    if (cumPnL > peak) peak = cumPnL;
    const dd = peak - cumPnL;
    if (dd > drawdown) drawdown = dd;
  }

  const rrList = trades.map((t) => {
    const risk   = Math.abs(t.entry - t.stopLoss);
    const reward = Math.abs(t.exit  - t.entry);
    return risk > 0 ? reward / risk : 0;
  });
  const avgRiskReward = parseFloat((rrList.reduce((s, r) => s + r, 0) / rrList.length).toFixed(2));

  let running = 0;
  const equityCurve = [...trades]
    .sort((a, b) => new Date(a.exitTime) - new Date(b.exitTime))
    .map((t) => { running += t.profit; return { time: t.exitTime, symbol: t.symbol, action: t.action, result: t.result, profit: parseFloat(t.profit.toFixed(2)), cumProfit: parseFloat(running.toFixed(2)) }; });

  const dayMap = {};
  for (const t of trades) {
    const day = (t.exitTime || t.entryTime).slice(0, 10);
    if (!dayMap[day]) dayMap[day] = { trades: 0, wins: 0, profit: 0, costs: 0 };
    dayMap[day].trades++;
    if (t.result === 'WIN') dayMap[day].wins++;
    dayMap[day].profit += t.profit;
    dayMap[day].costs  += t.tradingCost || 0;
  }
  const dailyStats = Object.entries(dayMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      date, trades: d.trades, wins: d.wins, losses: d.trades - d.wins,
      winRate: parseFloat(((d.wins / d.trades) * 100).toFixed(1)),
      profit:  parseFloat(d.profit.toFixed(2)),
      costs:   parseFloat(d.costs.toFixed(2)),
    }));

  return {
    totalTrades: trades.length, winningTrades: wins.length, losingTrades: losses.length,
    winRate: parseFloat(((wins.length / trades.length) * 100).toFixed(1)),
    totalProfit, totalCosts,
    maxDrawdown: parseFloat((-drawdown).toFixed(2)),
    avgRiskReward, equityCurve, dailyStats,
  };
}

// ─── Persist results ──────────────────────────────────────────────────────────

function persistResults(result) {
  try {
    let existing = {};
    if (fs.existsSync(RESULTS_PATH)) {
      existing = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
    }
    const runId = `${result.symbol || 'portfolio'}_${result.fromDate}_${result.toDate}_${Date.now()}`;
    existing[runId] = {
      runAt:       new Date().toISOString(),
      symbol:      result.symbol || null,
      symbols:     result.symbols || null,
      fromDate:    result.fromDate,
      toDate:      result.toDate,
      days:        result.days,
      dataSource:  result.dataSource || 'zerodha',
      candles:     result.candles,
      totalTrades: result.totalTrades,
      winRate:     result.winRate,
      totalProfit: result.totalProfit,
      totalCosts:  result.totalCosts,
      maxDrawdown: result.maxDrawdown,
      avgRiskReward: result.avgRiskReward,
      dailyStats:  result.dailyStats,
    };
    // Keep only the last 50 runs to avoid unbounded growth
    const keys = Object.keys(existing);
    if (keys.length > 50) {
      const oldest = keys.sort().slice(0, keys.length - 50);
      oldest.forEach((k) => delete existing[k]);
    }
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(existing, null, 2));
    console.log(`[Backtest] Results saved to data/backtest-results.json (runId: ${runId})`);
  } catch (err) {
    console.warn(`[Backtest] Could not persist results: ${err.message}`);
  }
}

// ─── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Run a single-symbol backtest on real Zerodha 15-min data.
 * Throws if Zerodha credentials are missing or the API call fails.
 * Persists result to data/backtest-results.json.
 *
 * @param {string} symbol  e.g. 'RELIANCE'
 * @param {number} days    calendar days to look back (1–60, default 30)
 * @returns {Promise<Object>}
 */
async function runBacktest(symbol, days = 30) {
  const ticker   = symbol.toUpperCase().replace('NSE:', '');
  const safeDays = Math.min(Math.max(parseInt(days, 10) || 30, 1), 60);

  const toDate   = new Date();
  const fromDate = new Date(toDate);
  fromDate.setDate(fromDate.getDate() - safeDays);
  const fromStr = fromDate.toISOString().slice(0, 10);
  const toStr   = toDate.toISOString().slice(0, 10);

  console.log(`[Backtest] ${ticker} — fetching ${safeDays}d of 15-min candles (${fromStr} → ${toStr})...`);
  const candles = await fetchHistoricalCandles(ticker, fromStr, toStr);
  console.log(`[Backtest] ${ticker} — ${candles.length} candles received`);

  const trades  = replayCandles(candles, ticker);
  const metrics = computeMetrics(trades);

  console.log(
    `[Backtest] ${ticker} — ${metrics.totalTrades} trades | ` +
    `WR ${metrics.winRate}% | P&L ₹${metrics.totalProfit} | costs ₹${metrics.totalCosts}`
  );
  if (metrics.totalTrades < 5) {
    console.warn(`[Backtest] ${ticker} — only ${metrics.totalTrades} trades (need ≥5 for reliable WR). Extend date range.`);
  }

  const result = {
    symbol: ticker, fromDate: fromStr, toDate: toStr, days: safeDays,
    dataSource: 'zerodha_15min', candles: candles.length,
    ...metrics, trades,
  };
  persistResults(result);
  return result;
}

// ─── Portfolio Backtest ───────────────────────────────────────────────────────

const DEFAULT_SYMBOLS = [
  'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK',
  'SBIN', 'KOTAKBANK', 'LT', 'AXISBANK', 'WIPRO',
  'TITAN', 'MARUTI', 'SUNPHARMA', 'TATASTEEL', 'ADANIPORTS',
];

/**
 * Run backtest across multiple symbols, aggregate, and persist.
 * Symbols that fail (e.g. bad token, no data) are skipped with a warning.
 *
 * @param {string[]} symbols  default: 15 liquid Nifty 50 stocks
 * @param {number}   days     calendar days to look back
 * @returns {Promise<Object>}
 */
async function runPortfolioBacktest(symbols = DEFAULT_SYMBOLS, days = 30) {
  const safeDays = Math.min(Math.max(parseInt(days, 10) || 30, 1), 60);
  const tickers  = symbols.map((s) => s.toUpperCase().replace('NSE:', ''));

  console.log(`[Portfolio] Backtesting ${tickers.length} symbols over ${safeDays} days...`);

  const results = await Promise.all(
    tickers.map((ticker) =>
      runBacktest(ticker, safeDays).catch((err) => {
        console.warn(`[Portfolio] ${ticker} failed: ${err.message}`);
        return null;
      })
    )
  );

  const valid     = results.filter(Boolean);
  const perSymbol = valid.map(({ trades: _t, equityCurve: _eq, ...rest }) => rest);
  const allTrades = valid.flatMap((r) => r.trades || []);
  allTrades.sort((a, b) => new Date(a.entryTime) - new Date(b.entryTime));

  const portfolioMetrics = computeMetrics(allTrades);

  console.log(
    `[Portfolio] Done — ${portfolioMetrics.totalTrades} trades across ${valid.length}/${tickers.length} symbols | ` +
    `WR ${portfolioMetrics.winRate}% | P&L ₹${portfolioMetrics.totalProfit}`
  );

  const result = {
    symbols: tickers, symbolsRun: valid.length,
    fromDate: valid[0]?.fromDate, toDate: valid[0]?.toDate,
    days: safeDays, dataSource: 'zerodha_15min',
    candles: valid.reduce((s, r) => s + (r.candles || 0), 0),
    ...portfolioMetrics, perSymbol, trades: allTrades,
  };
  persistResults(result);
  return result;
}

module.exports = { runBacktest, runPortfolioBacktest };

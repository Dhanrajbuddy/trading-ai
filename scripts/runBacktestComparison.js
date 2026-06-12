'use strict';

/**
 * runBacktestComparison.js
 *
 * Runs a side-by-side A/B backtest comparison:
 *   A = Original strategy  (MIN_CONFIDENCE=60, no ORB range filter, no trend filter)
 *   B = Current strategy   (MIN_CONFIDENCE=68, ORB_MIN_RANGE_PCT=0.30%, trend filter ON)
 *
 * Both runs use identical real Zerodha 15-min candles for the same date range.
 * Results saved to data/backtest-results.json and printed to stdout.
 *
 * Usage (inside container):
 *   node /app/scripts/runBacktestComparison.js [days=45] [symbols=RELIANCE,TCS,...]
 */

require('dotenv').config({ path: '/app/.env' });

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

// ─── Shared helpers (copied inline so we can run both configs without modifying orbCore) ─

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

async function fetchCandles(symbol, fromDate, toDate) {
  const token = INSTRUMENT_TOKENS[symbol];
  if (!token) throw new Error(`No token for ${symbol}`);
  const url = `https://api.kite.trade/instruments/historical/${token}/15minute` +
              `?from=${encodeURIComponent(fromDate + ' 09:00:00')}` +
              `&to=${encodeURIComponent(toDate + ' 15:30:00')}&continuous=0&oi=0`;
  const resp = await axios.get(url, {
    headers: {
      'X-Kite-Version': '3',
      Authorization: `token ${process.env.ZERODHA_API_KEY}:${process.env.ZERODHA_ACCESS_TOKEN}`,
    },
    timeout: 20_000,
  });
  const c = resp.data?.data?.candles;
  if (!Array.isArray(c) || c.length === 0) throw new Error(`No candles for ${symbol}`);
  return c;
}

function computeRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  const slice = prices.slice(-(period + 1));
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const ag = gains / period, al = losses / period;
  if (ag === 0 && al === 0) return 50;
  if (al === 0) return 100;
  if (ag === 0) return 0;
  return parseFloat((100 - 100 / (1 + ag / al)).toFixed(1));
}

function calcCosts(action, entry, exit_, qty) {
  const ev = entry * qty, xv = exit_ * qty;
  const slip = (ev + xv) * 0.001;
  const brok = Math.min(ev * 0.0003, 20) + Math.min(xv * 0.0003, 20);
  const stt  = (action === 'BUY' ? xv : ev) * 0.00025;
  const exch = (ev + xv) * 0.0000325;
  const gst  = (brok + exch) * 0.18;
  return parseFloat((slip + brok + stt + exch + gst).toFixed(2));
}

function getCandleMinsIST(ts) {
  const d = new Date(ts);
  const ist = new Date(d.getTime() + 5.5 * 3600_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function scoreSignal(action, rsi, vm, price, vwap, orbRange) {
  let score = 40;
  if (action === 'BUY') {
    if (rsi !== null && rsi >= 50 && rsi <= 68) score += 15;
    else if (rsi !== null && rsi >= 45 && rsi < 50) score += 10;
  } else {
    if (rsi !== null && rsi >= 32 && rsi <= 50) score += 15;
    else if (rsi !== null && rsi > 50 && rsi <= 55) score += 10;
  }
  if (vm != null) {
    if      (vm >= 3.0) score += 20;
    else if (vm >= 2.0) score += 15;
    else if (vm >= 1.5) score += 8;
  }
  if (orbRange != null && price > 0) {
    const rp = orbRange / price * 100;
    if (rp >= 0.8) score += 15;
    else if (rp >= 0.5) score += 10;
    else if (rp >= 0.3) score += 5;
  }
  if (vwap != null) {
    if ((action === 'BUY' && price > vwap) || (action === 'SELL' && price < vwap)) score += 5;
  }
  return Math.min(score, 100);
}

// ─── Core replay — parametric so A/B can differ ───────────────────────────────

function replayCandles(candles, symbol, cfg) {
  const {
    MIN_CONFIDENCE, VOLUME_SPIKE_MIN, ORB_BUFFER_PCT, ORB_MIN_RANGE_PCT,
    ORB_CANDLES, MAX_TRADES_PER_DAY, COOLDOWN_CANDLES,
    WINDOW_START_MINS, ENTRY_CUTOFF_MINS, CLOSE_ALL_MINS,
    BULL_MARKET_THRESHOLD, CAPITAL_PER_TRADE,
    SL_PCT, TARGET_MULT, TARGET_PCT_FALLBACK,
  } = cfg;

  const trades = [], closeHist = [], volHist = [], vwapHist = [];
  let vwapAccum = 0, vwapVol = 0;
  let orbHigh = -Infinity, orbLow = Infinity, orbEst = false;
  let curDay = '', dayCnt = 0, dayTrades = 0, dayTradeDay = '';
  let lastSigIdx = -999, openTrade = null;

  for (let i = 0; i < candles.length; i++) {
    const [ts, open, high, low, close, rawVol] = candles[i];
    const vol = (typeof rawVol === 'number' && isFinite(rawVol) && rawVol > 0) ? rawVol : null;
    const mins = getCandleMinsIST(ts);
    const date = ts.slice(0, 10);

    if (date !== curDay) {
      vwapAccum = 0; vwapVol = 0;
      orbHigh = -Infinity; orbLow = Infinity; orbEst = false;
      dayCnt = 0; curDay = date;
      if (dayTradeDay !== date) { dayTrades = 0; dayTradeDay = date; }
      if (openTrade) {
        const { action: a, entry, sl, target, qty, entryTs, entryIdx } = openTrade;
        const gp = a === 'BUY' ? (open - entry) * qty : (entry - open) * qty;
        const cost = calcCosts(a, entry, open, qty);
        trades.push({ symbol, action: a, entry: +entry.toFixed(2), exit: +open.toFixed(2),
          sl: +sl.toFixed(2), target: +target.toFixed(2), qty,
          profit: +((gp - cost).toFixed(2)), result: (gp - cost) >= 0 ? 'WIN' : 'LOSS',
          entryTime: entryTs, exitTime: ts, note: 'overnight' });
        openTrade = null;
      }
    }

    const tp = (high + low + close) / 3;
    if (vol !== null) { vwapAccum += tp * vol; vwapVol += vol; }
    const vwap = vwapVol > 0 ? vwapAccum / vwapVol : null;

    closeHist.push(close); if (closeHist.length > 30) closeHist.shift();
    dayCnt++;
    if (vol !== null) { volHist.push(vol); if (volHist.length > 20) volHist.shift(); }
    if (vwap !== null) { vwapHist.push(close > vwap ? 1 : 0); if (vwapHist.length > 20) vwapHist.shift(); }

    if (!orbEst) {
      orbHigh = Math.max(orbHigh, high);
      orbLow  = Math.min(orbLow,  low);
      if (dayCnt >= ORB_CANDLES) orbEst = true;
      continue;
    }

    if (openTrade) {
      const { action: a, entry, sl, target, qty, entryTs, entryIdx } = openTrade;
      if (mins >= CLOSE_ALL_MINS) {
        const gp = a === 'BUY' ? (close - entry) * qty : (entry - close) * qty;
        const cost = calcCosts(a, entry, close, qty);
        trades.push({ symbol, action: a, entry: +entry.toFixed(2), exit: +close.toFixed(2),
          sl: +sl.toFixed(2), target: +target.toFixed(2), qty,
          profit: +((gp - cost).toFixed(2)), result: (gp - cost) >= 0 ? 'WIN' : 'LOSS',
          entryTime: entryTs, exitTime: ts, note: '3:15 squareoff' });
        openTrade = null; continue;
      }
      const slHit  = (a === 'BUY' && low  <= sl)    || (a === 'SELL' && high >= sl);
      const tgtHit = (a === 'BUY' && high >= target) || (a === 'SELL' && low  <= target);
      if (slHit || tgtHit) {
        const exitP = slHit ? sl : target;
        const res   = slHit ? 'LOSS' : 'WIN';
        const gp    = a === 'BUY' ? (exitP - entry) * qty : (entry - exitP) * qty;
        const cost  = calcCosts(a, entry, exitP, qty);
        trades.push({ symbol, action: a, entry: +entry.toFixed(2), exit: +exitP.toFixed(2),
          sl: +sl.toFixed(2), target: +target.toFixed(2), qty,
          profit: +((gp - cost).toFixed(2)), result: res,
          entryTime: entryTs, exitTime: ts });
        openTrade = null;
      }
      if (openTrade) continue;
    }

    if (mins < WINDOW_START_MINS || mins > ENTRY_CUTOFF_MINS) continue;
    if (dayTrades >= MAX_TRADES_PER_DAY) continue;
    if (i - lastSigIdx < COOLDOWN_CANDLES) continue;
    if ((high - low) / close < 0.002) continue;

    const orbRange = orbHigh - orbLow;
    // A/B difference: ORB minimum range filter
    if (ORB_MIN_RANGE_PCT > 0 && (orbRange / close * 100) < ORB_MIN_RANGE_PCT) continue;

    const orbBufH = orbHigh * (1 + ORB_BUFFER_PCT / 100);
    const orbBufL = orbLow  * (1 - ORB_BUFFER_PCT / 100);

    const rsi = computeRSI(closeHist);
    const avgVol = volHist.length > 1
      ? volHist.slice(0, -1).reduce((s, v) => s + v, 0) / (volHist.length - 1)
      : (volHist[0] ?? 0);
    const vm = (vol !== null && avgVol > 0) ? +(vol / avgVol).toFixed(2) : null;
    const hasSpike = vm != null && vm >= VOLUME_SPIKE_MIN;

    const rsiOkBuy  = rsi !== null && rsi >= 45 && rsi <= 72;
    const rsiOkSell = rsi !== null && rsi >= 28 && rsi <= 55;

    const vwapAbove = vwap !== null && close > vwap;
    const vwapBelow = vwap !== null && close < vwap;

    // A/B difference: trend filter
    const breadth = vwapHist.length > 0
      ? vwapHist.reduce((s, v) => s + v, 0) / vwapHist.length
      : 0.5;
    const isBull = BULL_MARKET_THRESHOLD > 0 && breadth >= BULL_MARKET_THRESHOLD;

    const isBuy  = close > orbBufH && close > open && hasSpike && rsiOkBuy  && vwapAbove;
    const isSell = close < orbBufL && close < open && hasSpike && rsiOkSell && vwapBelow && !isBull;

    if (!isBuy && !isSell) continue;

    const action = isBuy ? 'BUY' : 'SELL';
    const score  = scoreSignal(action, rsi, vm, close, vwap, orbRange);

    // A/B difference: MIN_CONFIDENCE threshold
    if (score < MIN_CONFIDENCE) continue;

    const sl = action === 'BUY'
      ? +(close * (1 - SL_PCT / 100)).toFixed(2)
      : +(close * (1 + SL_PCT / 100)).toFixed(2);

    const orbPct    = orbRange / close * 100;
    const tgtPct    = Math.max(orbPct * TARGET_MULT, TARGET_PCT_FALLBACK);
    const target    = action === 'BUY'
      ? +(close * (1 + tgtPct / 100)).toFixed(2)
      : +(close * (1 - tgtPct / 100)).toFixed(2);

    const qty = Math.floor(CAPITAL_PER_TRADE / close);
    if (qty <= 0) continue;

    lastSigIdx = i; dayTrades++;
    openTrade = { action, entry: close, sl, target, qty, entryIdx: i, entryTs: ts };
  }

  if (openTrade && candles.length > 0) {
    const [lts, , , , lclose] = candles[candles.length - 1];
    const { action: a, entry, sl, target, qty, entryTs } = openTrade;
    const gp = a === 'BUY' ? (lclose - entry) * qty : (entry - lclose) * qty;
    const cost = calcCosts(a, entry, lclose, qty);
    trades.push({ symbol, action: a, entry: +entry.toFixed(2), exit: +lclose.toFixed(2),
      sl: +sl.toFixed(2), target: +target.toFixed(2), qty,
      profit: +((gp - cost).toFixed(2)), result: (gp - cost) >= 0 ? 'WIN' : 'LOSS',
      entryTime: entryTs, exitTime: lts, note: 'end-of-data' });
  }
  return trades;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

function metrics(trades, days) {
  if (trades.length === 0) return {
    trades: 0, wins: 0, losses: 0, winRate: 0, netPnL: 0, totalCosts: 0,
    profitFactor: 0, avgRR: 0, maxDrawdown: 0, tradesPerDay: 0,
    buyWR: 0, sellWR: 0, buys: 0, sells: 0,
  };

  const wins   = trades.filter(t => t.result === 'WIN');
  const losses = trades.filter(t => t.result === 'LOSS');
  const buys   = trades.filter(t => t.action === 'BUY');
  const sells  = trades.filter(t => t.action === 'SELL');
  const buyWins  = buys.filter(t => t.result === 'WIN');
  const sellWins = sells.filter(t => t.result === 'SELL'); // intentional bug guard below

  const netPnL = +trades.reduce((s, t) => s + t.profit, 0).toFixed(2);

  const grossWin  = wins.reduce((s, t) => s + t.profit, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.profit, 0));
  const profitFactor = grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : grossWin > 0 ? 999 : 0;

  const rrList = trades.map(t => {
    const risk   = Math.abs(t.entry - t.sl);
    const reward = Math.abs(t.exit - t.entry);
    return risk > 0 ? reward / risk : 0;
  });
  const avgRR = +(rrList.reduce((s, r) => s + r, 0) / rrList.length).toFixed(2);

  let peak = 0, cum = 0, dd = 0;
  for (const t of trades) {
    cum += t.profit;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
  }

  const tradingDays = Math.max(days * 5/7, 1);  // approx market days

  return {
    trades:       trades.length,
    wins:         wins.length,
    losses:       losses.length,
    winRate:      +(wins.length / trades.length * 100).toFixed(1),
    netPnL,
    totalCosts:   +trades.reduce((s, t) => s + (t.cost || 0), 0).toFixed(2),
    profitFactor,
    avgRR,
    maxDrawdown:  +(-dd).toFixed(2),
    tradesPerDay: +(trades.length / tradingDays).toFixed(2),
    buys:         buys.length,
    sells:        sells.length,
    buyWR:        buys.length > 0 ? +(buyWins.length / buys.length * 100).toFixed(1) : 0,
    sellWR:       sells.length > 0 ? +(sells.filter(t => t.result === 'WIN').length / sells.length * 100).toFixed(1) : 0,
  };
}

function symbolMetrics(trades) {
  const bySymbol = {};
  for (const t of trades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = [];
    bySymbol[t.symbol].push(t);
  }
  return Object.entries(bySymbol).map(([sym, ts]) => {
    const m = metrics(ts, 1);
    return { symbol: sym, trades: m.trades, winRate: m.winRate, netPnL: +ts.reduce((s, t) => s + t.profit, 0).toFixed(2) };
  }).sort((a, b) => b.netPnL - a.netPnL);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const DAYS    = parseInt(process.argv[2], 10) || 45;
const SYMBOLS = process.argv[3]
  ? process.argv[3].split(',')
  : [
      'RELIANCE', 'TCS',      'INFY',    'HDFCBANK',  'ICICIBANK',
      'SBIN',     'KOTAKBANK','LT',       'AXISBANK',  'WIPRO',
      'TITAN',    'MARUTI',   'SUNPHARMA','TATASTEEL', 'ADANIPORTS',
      'HCLTECH',  'BAJFINANCE','ONGC',   'BHARTIARTL', 'TECHM',
    ];

const CFG_A = {   // Original strategy
  MIN_CONFIDENCE:   60,
  VOLUME_SPIKE_MIN: 1.5,
  ORB_BUFFER_PCT:   0.10,
  ORB_MIN_RANGE_PCT: 0,     // no filter
  ORB_CANDLES:      2,
  MAX_TRADES_PER_DAY: 2,
  COOLDOWN_CANDLES: 2,
  WINDOW_START_MINS: 9*60+30,
  ENTRY_CUTOFF_MINS: 14*60+30,
  CLOSE_ALL_MINS:   15*60+15,
  BULL_MARKET_THRESHOLD: 0, // no trend filter
  CAPITAL_PER_TRADE: 16_000,
  SL_PCT:           0.5,
  TARGET_MULT:      2.0,
  TARGET_PCT_FALLBACK: 1.0,
};

const CFG_B = {   // Current strategy (all improvements)
  ...CFG_A,
  MIN_CONFIDENCE:       68,
  ORB_MIN_RANGE_PCT:    0.30,
  BULL_MARKET_THRESHOLD: 0.55,
};

const toDate   = new Date();
const fromDate = new Date(toDate);
fromDate.setDate(fromDate.getDate() - DAYS);
const fromStr  = fromDate.toISOString().slice(0, 10);
const toStr    = toDate.toISOString().slice(0, 10);

const RESULTS_PATH = path.resolve('/app/data/backtest-results.json');

async function main() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  BACKTEST COMPARISON  |  ${fromStr} → ${toStr}  |  ${SYMBOLS.length} symbols`);
  console.log(`${'═'.repeat(70)}\n`);

  const allTradesA = [], allTradesB = [], symbolSummary = [];
  let fetched = 0, failed = 0;

  for (const sym of SYMBOLS) {
    process.stdout.write(`  Fetching ${sym.padEnd(12)}`);
    let candles;
    try {
      candles = await fetchCandles(sym, fromStr, toStr);
      fetched++;
      process.stdout.write(`${candles.length} candles\n`);
    } catch (err) {
      failed++;
      process.stdout.write(`FAILED: ${err.message}\n`);
      continue;
    }

    // Small delay to stay well within Zerodha rate limits (3 req/sec)
    await new Promise(r => setTimeout(r, 400));

    const tA = replayCandles(candles, sym, CFG_A);
    const tB = replayCandles(candles, sym, CFG_B);
    allTradesA.push(...tA);
    allTradesB.push(...tB);
    symbolSummary.push({
      symbol:  sym,
      candleCount: candles.length,
      A: { trades: tA.length, winRate: tA.length > 0 ? +(tA.filter(t=>t.result==='WIN').length/tA.length*100).toFixed(1) : 0, pnl: +tA.reduce((s,t)=>s+t.profit,0).toFixed(2) },
      B: { trades: tB.length, winRate: tB.length > 0 ? +(tB.filter(t=>t.result==='WIN').length/tB.length*100).toFixed(1) : 0, pnl: +tB.reduce((s,t)=>s+t.profit,0).toFixed(2) },
    });
  }

  const mA = metrics(allTradesA, DAYS);
  const mB = metrics(allTradesB, DAYS);

  const smA = symbolMetrics(allTradesA);
  const smB = symbolMetrics(allTradesB);

  // ─── Print comparison ───────────────────────────────────────────────────────

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  PORTFOLIO SUMMARY  |  A=Original  B=Current (all fixes)`);
  console.log(`${'─'.repeat(70)}`);
  const f = (k, va, vb, better='higher') => {
    const up = better === 'higher' ? vb > va : vb < va;
    const arrow = up ? '▲' : va === vb ? '=' : '▼';
    console.log(`  ${k.padEnd(22)} A: ${String(va).padStart(8)}    B: ${String(vb).padStart(8)}  ${arrow}`);
  };
  f('Total trades',    mA.trades,       mB.trades);
  f('Win rate %',      mA.winRate,      mB.winRate);
  f('Net P&L ₹',       mA.netPnL,       mB.netPnL);
  f('Profit factor',   mA.profitFactor, mB.profitFactor);
  f('Avg R:R',         mA.avgRR,        mB.avgRR);
  f('Max drawdown ₹',  mA.maxDrawdown,  mB.maxDrawdown, 'higher');
  f('Trades/day',      mA.tradesPerDay, mB.tradesPerDay);
  f('BUYs',           mA.buys,         mB.buys);
  f('BUY win rate %',  mA.buyWR,        mB.buyWR);
  f('SELLs',          mA.sells,        mB.sells);
  f('SELL win rate %', mA.sellWR,       mB.sellWR);

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  PER-SYMBOL BREAKDOWN`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`  ${'Symbol'.padEnd(13)} ${'A-Tr'.padStart(5)} ${'A-WR%'.padStart(6)} ${'A-PnL'.padStart(8)}  |  ${'B-Tr'.padStart(5)} ${'B-WR%'.padStart(6)} ${'B-PnL'.padStart(8)}`);
  for (const s of symbolSummary) {
    console.log(`  ${s.symbol.padEnd(13)} ${String(s.A.trades).padStart(5)} ${String(s.A.winRate).padStart(6)} ${String(s.A.pnl).padStart(8)}  |  ${String(s.B.trades).padStart(5)} ${String(s.B.winRate).padStart(6)} ${String(s.B.pnl).padStart(8)}`);
  }

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  TOP 5 SYMBOLS (B — Current Strategy, by P&L)`);
  console.log(`${'─'.repeat(70)}`);
  smB.slice(0, 5).forEach(s => console.log(`  ${s.symbol.padEnd(13)} ${s.trades} trades  WR ${s.winRate}%  P&L ₹${s.netPnL}`));

  console.log(`\n  WORST 5 SYMBOLS (B — Current Strategy, by P&L)`);
  smB.slice(-5).reverse().forEach(s => console.log(`  ${s.symbol.padEnd(13)} ${s.trades} trades  WR ${s.winRate}%  P&L ₹${s.netPnL}`));

  const tradingDaysActual = new Set(allTradesB.map(t => t.entryTime.slice(0, 10))).size;
  const dailyPnL = tradingDaysActual > 0 ? +(mB.netPnL / tradingDaysActual).toFixed(2) : 0;

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  VERDICT (Strategy B — Current)`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`  Trading days with signals:  ${tradingDaysActual}`);
  console.log(`  Avg P&L per signal day:     ₹${dailyPnL}`);
  console.log(`  Capital:                    ₹20,000`);
  const targetMet = dailyPnL >= 100;
  console.log(`  ₹100–₹200/day target:       ${targetMet ? '✓ MET' : '✗ NOT MET'}`);
  console.log(`  Profitable overall:         ${mB.netPnL > 0 ? '✓ YES' : '✗ NO'}`);
  console.log(`  Profit factor > 1.0:        ${mB.profitFactor > 1 ? `✓ YES (${mB.profitFactor})` : `✗ NO (${mB.profitFactor})`}`);

  if (mB.netPnL <= 0 || mB.profitFactor <= 1) {
    console.log(`\n  ⚠️  NOT PROFITABLE. Identifying largest weakness...`);
    const buyPnL  = allTradesB.filter(t=>t.action==='BUY') .reduce((s,t)=>s+t.profit,0);
    const sellPnL = allTradesB.filter(t=>t.action==='SELL').reduce((s,t)=>s+t.profit,0);
    console.log(`  BUY  total P&L:  ₹${buyPnL.toFixed(2)}`);
    console.log(`  SELL total P&L:  ₹${sellPnL.toFixed(2)}`);
    const slHits = allTradesB.filter(t=>t.result==='LOSS').length;
    const tgtHits = allTradesB.filter(t=>t.result==='WIN').length;
    console.log(`  SL hits / target hits: ${slHits} / ${tgtHits}`);
    const avgLoss = allTradesB.filter(t=>t.result==='LOSS').reduce((s,t)=>s+t.profit,0) / (slHits||1);
    const avgWin  = allTradesB.filter(t=>t.result==='WIN') .reduce((s,t)=>s+t.profit,0) / (tgtHits||1);
    console.log(`  Avg WIN: ₹${avgWin.toFixed(2)}  Avg LOSS: ₹${avgLoss.toFixed(2)}`);
  }

  // ─── Persist to data/backtest-results.json ───────────────────────────────────
  let existing = {};
  if (fs.existsSync(RESULTS_PATH)) {
    try { existing = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8')); } catch {}
  }
  const runId = `comparison_${fromStr}_${toStr}_${Date.now()}`;
  existing[runId] = {
    runAt: new Date().toISOString(),
    type: 'A_B_comparison',
    fromDate: fromStr, toDate: toStr, days: DAYS,
    symbols: SYMBOLS, fetched, failed,
    A: { config: { MIN_CONFIDENCE: CFG_A.MIN_CONFIDENCE, ORB_MIN_RANGE_PCT: CFG_A.ORB_MIN_RANGE_PCT, BULL_MARKET_THRESHOLD: CFG_A.BULL_MARKET_THRESHOLD }, ...mA },
    B: { config: { MIN_CONFIDENCE: CFG_B.MIN_CONFIDENCE, ORB_MIN_RANGE_PCT: CFG_B.ORB_MIN_RANGE_PCT, BULL_MARKET_THRESHOLD: CFG_B.BULL_MARKET_THRESHOLD }, ...mB },
    symbolSummary,
    topSymbols:   smB.slice(0, 5),
    worstSymbols: smB.slice(-5).reverse(),
  };
  const keys = Object.keys(existing);
  if (keys.length > 50) keys.sort().slice(0, keys.length - 50).forEach(k => delete existing[k]);
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(existing, null, 2));
  console.log(`\n  Results saved → data/backtest-results.json (runId: ${runId})`);
  console.log(`${'═'.repeat(70)}\n`);
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  if (err.response?.data) console.error('API response:', JSON.stringify(err.response.data));
  process.exit(1);
});

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

// override:true is required — the container's start-time ZERODHA_ACCESS_TOKEN
// (baked into the process env at `docker compose up`) goes stale daily. The live
// app refreshes the token in .env via browser re-login; we must prefer that value.
require('dotenv').config({ path: '/app/.env', override: true });

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

// ─── Forward simulation for filtered-trade analysis ──────────────────────────
// Given a breakout candle that FAILED confirmation, simulate what would have
// happened had it entered immediately at the breakout candle close (B-style).
// Returns the eventual outcome so we can measure whether confirmation removed
// false breakouts (losers) or also discarded real moves (winners).
function simulateForward(candles, startIdx, action, entry, sl, target, qty, CLOSE_ALL_MINS) {
  const startDay = candles[startIdx][0].slice(0, 10);
  for (let j = startIdx + 1; j < candles.length; j++) {
    const [ts, open, high, low, close] = candles[j];
    if (ts.slice(0, 10) !== startDay) {
      // overnight — exit at next day's open
      const gp = action === 'BUY' ? (open - entry) * qty : (entry - open) * qty;
      const cost = calcCosts(action, entry, open, qty);
      return { result: (gp - cost) >= 0 ? 'WIN' : 'LOSS', profit: +(gp - cost).toFixed(2), exitReason: 'overnight' };
    }
    const mins = getCandleMinsIST(ts);
    if (mins >= CLOSE_ALL_MINS) {
      const gp = action === 'BUY' ? (close - entry) * qty : (entry - close) * qty;
      const cost = calcCosts(action, entry, close, qty);
      return { result: (gp - cost) >= 0 ? 'WIN' : 'LOSS', profit: +(gp - cost).toFixed(2), exitReason: 'squareoff' };
    }
    const slHit  = (action === 'BUY' && low  <= sl)    || (action === 'SELL' && high >= sl);
    const tgtHit = (action === 'BUY' && high >= target) || (action === 'SELL' && low  <= target);
    if (slHit || tgtHit) {
      const exitP = slHit ? sl : target;
      const gp = action === 'BUY' ? (exitP - entry) * qty : (entry - exitP) * qty;
      const cost = calcCosts(action, entry, exitP, qty);
      return { result: slHit ? 'LOSS' : 'WIN', profit: +(gp - cost).toFixed(2), exitReason: slHit ? 'SL' : 'target' };
    }
  }
  // ran out of data
  const [, , , , lclose] = candles[candles.length - 1];
  const gp = action === 'BUY' ? (lclose - entry) * qty : (entry - lclose) * qty;
  const cost = calcCosts(action, entry, lclose, qty);
  return { result: (gp - cost) >= 0 ? 'WIN' : 'LOSS', profit: +(gp - cost).toFixed(2), exitReason: 'end-of-data' };
}

// ─── Trade planning helpers ───────────────────────────────────────────────────

// Momentum entry plan. SL_MODE 'fixed' = 0.5% from entry; 'structure' = opposite
// ORB boundary (natural invalidation). RISK_PER_TRADE (₹) sizes by risk to hold
// loss-per-trade roughly constant; otherwise size by fixed capital.
function momentumPlan(action, close, orbHigh, orbLow, cfg) {
  const orbRange = orbHigh - orbLow;
  let sl;
  if (cfg.SL_MODE === 'structure') {
    sl = action === 'BUY' ? +orbLow.toFixed(2) : +orbHigh.toFixed(2);
  } else {
    sl = action === 'BUY'
      ? +(close * (1 - cfg.SL_PCT / 100)).toFixed(2)
      : +(close * (1 + cfg.SL_PCT / 100)).toFixed(2);
  }
  const orbPct = orbRange / close * 100;
  const tgtPct = Math.max(orbPct * cfg.TARGET_MULT, cfg.TARGET_PCT_FALLBACK);
  const target = action === 'BUY'
    ? +(close * (1 + tgtPct / 100)).toFixed(2)
    : +(close * (1 - tgtPct / 100)).toFixed(2);
  const slDist = Math.abs(close - sl);
  let qty;
  if (cfg.RISK_PER_TRADE && slDist > 0) {
    qty = Math.min(Math.floor(cfg.RISK_PER_TRADE / slDist), Math.floor(cfg.CAPITAL_PER_TRADE / close));
  } else {
    qty = Math.floor(cfg.CAPITAL_PER_TRADE / close);
  }
  return { sl, target, qty };
}

// Fade entry plan (mean reversion). action is the FADE direction. Target = VWAP
// when it sits on the profitable side, else the far ORB boundary. SL sits just
// beyond the failed-breakout extreme. Risk-sized.
function fadePlan(action, close, orbHigh, orbLow, vwap, breakoutHigh, breakoutLow, cfg) {
  const mode = cfg.FADE_TARGET_MODE || 'vwap';
  const rMult = cfg.FADE_R_MULT || 1.5;
  let sl, target;
  if (action === 'SELL') {           // fading a failed upper breakout
    sl = +(breakoutHigh * 1.001).toFixed(2);
  } else {                            // fading a failed lower breakout
    sl = +(breakoutLow * 0.999).toFixed(2);
  }
  const slDist = Math.abs(close - sl);
  if (mode === 'orb_opposite') {
    target = action === 'SELL' ? +orbLow.toFixed(2) : +orbHigh.toFixed(2);
  } else if (mode === 'rmult') {
    target = action === 'SELL'
      ? +(close - rMult * slDist).toFixed(2)
      : +(close + rMult * slDist).toFixed(2);
  } else { // vwap
    if (action === 'SELL') target = (vwap != null && vwap < close) ? +vwap.toFixed(2) : +orbLow.toFixed(2);
    else                   target = (vwap != null && vwap > close) ? +vwap.toFixed(2) : +orbHigh.toFixed(2);
  }
  let qty;
  if (cfg.RISK_PER_TRADE && slDist > 0) {
    qty = Math.min(Math.floor(cfg.RISK_PER_TRADE / slDist), Math.floor(cfg.CAPITAL_PER_TRADE / close));
  } else {
    qty = Math.floor(cfg.CAPITAL_PER_TRADE / close);
  }
  return { sl, target, qty };
}

// ─── Core replay — parametric so A/B/C can differ ─────────────────────────────

function replayCandles(candles, symbol, cfg) {
  const {
    MIN_CONFIDENCE, VOLUME_SPIKE_MIN, ORB_BUFFER_PCT, ORB_MIN_RANGE_PCT,
    ORB_CANDLES, MAX_TRADES_PER_DAY, COOLDOWN_CANDLES,
    WINDOW_START_MINS, ENTRY_CUTOFF_MINS, CLOSE_ALL_MINS,
    BULL_MARKET_THRESHOLD, CAPITAL_PER_TRADE,
    SL_PCT, TARGET_MULT, TARGET_PCT_FALLBACK,
    CONFIRMATION,
  } = cfg;

  const trades = [], filtered = [], closeHist = [], volHist = [], vwapHist = [];
  let vwapAccum = 0, vwapVol = 0;
  let orbHigh = -Infinity, orbLow = Infinity, orbEst = false;
  let curDay = '', dayCnt = 0, dayTrades = 0, dayTradeDay = '';
  let lastSigIdx = -999, openTrade = null, pending = null;

  for (let i = 0; i < candles.length; i++) {
    const [ts, open, high, low, close, rawVol] = candles[i];
    const vol = (typeof rawVol === 'number' && isFinite(rawVol) && rawVol > 0) ? rawVol : null;
    const mins = getCandleMinsIST(ts);
    const date = ts.slice(0, 10);

    if (date !== curDay) {
      vwapAccum = 0; vwapVol = 0;
      orbHigh = -Infinity; orbLow = Infinity; orbEst = false;
      dayCnt = 0; curDay = date; pending = null;
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

    const inWindow = mins >= WINDOW_START_MINS && mins <= ENTRY_CUTOFF_MINS;
    const orbRange = orbHigh - orbLow;
    const orbBufH  = orbHigh * (1 + ORB_BUFFER_PCT / 100);
    const orbBufL  = orbLow  * (1 - ORB_BUFFER_PCT / 100);

    // ── Confirmation resolution (CONFIRMATION mode only) ──────────────────────
    if (CONFIRMATION && pending) {
      const pb = pending; pending = null;
      const confirmed = pb.action === 'BUY' ? close > orbBufH : close < orbBufL;
      if (confirmed && inWindow && dayTrades < MAX_TRADES_PER_DAY) {
        const action = pb.action;
        const { sl, target, qty } = momentumPlan(action, close, orbHigh, orbLow, cfg);
        if (qty > 0) {
          lastSigIdx = i; dayTrades++;
          openTrade = { action, entry: close, sl, target, qty, entryIdx: i, entryTs: ts };
          continue;
        }
      } else if (!confirmed) {
        // Filtered: simulate what would have happened had it entered B-style
        // (immediately at the breakout candle close) to classify the removed trade.
        const o = simulateForward(candles, pb.breakoutIdx, pb.action, pb.entry, pb.sl, pb.target, pb.qty, CLOSE_ALL_MINS);
        filtered.push({ symbol, action: pb.action, breakoutTs: pb.entryTs, ...o });
      }
    }

    // ── Guards for detecting a NEW breakout ───────────────────────────────────
    if (!inWindow) continue;
    if (dayTrades >= MAX_TRADES_PER_DAY) continue;
    if (i - lastSigIdx < COOLDOWN_CANDLES) continue;
    if ((high - low) / close < 0.002) continue;
    if (ORB_MIN_RANGE_PCT > 0 && (orbRange / close * 100) < ORB_MIN_RANGE_PCT) continue;

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

    const { sl, target, qty } = momentumPlan(action, close, orbHigh, orbLow, cfg);
    if (qty <= 0) continue;

    if (CONFIRMATION) {
      // Breakout detected — await next-candle confirmation. Store full B-style
      // params so a failed confirmation can be simulated for the filtered report.
      pending = { action, breakoutIdx: i, entry: close, sl, target, qty, entryTs: ts };
    } else {
      lastSigIdx = i; dayTrades++;
      openTrade = { action, entry: close, sl, target, qty, entryIdx: i, entryTs: ts };
    }
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
  return { trades, filtered };
}

// ─── Fade replay (mean reversion on FAILED breakouts) ─────────────────────────
// Entry: price pokes beyond the ORB (with volume + candle direction), then the
// NEXT candle closes back INSIDE the range → failed breakout → fade it.
// This directly trades the setups the confirmation candle was discarding.
function replayFade(candles, symbol, cfg) {
  const {
    VOLUME_SPIKE_MIN, ORB_BUFFER_PCT, ORB_MIN_RANGE_PCT, ORB_CANDLES,
    MAX_TRADES_PER_DAY, COOLDOWN_CANDLES,
    WINDOW_START_MINS, ENTRY_CUTOFF_MINS, CLOSE_ALL_MINS,
  } = cfg;

  const trades = [], closeHist = [], volHist = [];
  let vwapAccum = 0, vwapVol = 0;
  let orbHigh = -Infinity, orbLow = Infinity, orbEst = false;
  let curDay = '', dayCnt = 0, dayTrades = 0, dayTradeDay = '';
  let lastSigIdx = -999, openTrade = null, pending = null;

  const closeTrade = (a, entry, exitP, qty, entryTs, ts, result, note) => {
    const gp = a === 'BUY' ? (exitP - entry) * qty : (entry - exitP) * qty;
    const cost = calcCosts(a, entry, exitP, qty);
    trades.push({ symbol, action: a, entry: +entry.toFixed(2), exit: +exitP.toFixed(2),
      sl: 0, target: 0, qty, profit: +((gp - cost).toFixed(2)),
      result: result || ((gp - cost) >= 0 ? 'WIN' : 'LOSS'), entryTime: entryTs, exitTime: ts, note });
  };

  for (let i = 0; i < candles.length; i++) {
    const [ts, open, high, low, close, rawVol] = candles[i];
    const vol = (typeof rawVol === 'number' && isFinite(rawVol) && rawVol > 0) ? rawVol : null;
    const mins = getCandleMinsIST(ts);
    const date = ts.slice(0, 10);

    if (date !== curDay) {
      vwapAccum = 0; vwapVol = 0;
      orbHigh = -Infinity; orbLow = Infinity; orbEst = false;
      dayCnt = 0; curDay = date; pending = null;
      if (dayTradeDay !== date) { dayTrades = 0; dayTradeDay = date; }
      if (openTrade) {
        const { action: a, entry, sl, target, qty, entryTs } = openTrade;
        closeTrade(a, entry, open, qty, entryTs, ts, null, 'overnight');
        openTrade = null;
      }
    }

    const tp = (high + low + close) / 3;
    if (vol !== null) { vwapAccum += tp * vol; vwapVol += vol; }
    const vwap = vwapVol > 0 ? vwapAccum / vwapVol : null;

    closeHist.push(close); if (closeHist.length > 30) closeHist.shift();
    dayCnt++;
    if (vol !== null) { volHist.push(vol); if (volHist.length > 20) volHist.shift(); }

    if (!orbEst) {
      orbHigh = Math.max(orbHigh, high);
      orbLow  = Math.min(orbLow,  low);
      if (dayCnt >= ORB_CANDLES) orbEst = true;
      continue;
    }

    // Manage open fade trade
    if (openTrade) {
      const { action: a, entry, sl, target, qty, entryTs } = openTrade;
      if (mins >= CLOSE_ALL_MINS) { closeTrade(a, entry, close, qty, entryTs, ts, null, 'squareoff'); openTrade = null; continue; }
      const slHit  = (a === 'BUY' && low  <= sl)    || (a === 'SELL' && high >= sl);
      const tgtHit = (a === 'BUY' && high >= target) || (a === 'SELL' && low  <= target);
      if (slHit || tgtHit) {
        closeTrade(a, entry, slHit ? sl : target, qty, entryTs, ts, slHit ? 'LOSS' : 'WIN', null);
        openTrade = null;
      }
      if (openTrade) continue;
    }

    const inWindow = mins >= WINDOW_START_MINS && mins <= ENTRY_CUTOFF_MINS;
    const orbBufH  = orbHigh * (1 + ORB_BUFFER_PCT / 100);
    const orbBufL  = orbLow  * (1 - ORB_BUFFER_PCT / 100);

    // Resolve pending failed-breakout → fade entry
    if (pending) {
      const pb = pending; pending = null;
      // Failed = price closed back INSIDE the ORB on this candle
      const failedUpper = pb.side === 'upper' && close < orbHigh;
      const failedLower = pb.side === 'lower' && close > orbLow;
      if ((failedUpper || failedLower) && inWindow && dayTrades < MAX_TRADES_PER_DAY) {
        const action = pb.side === 'upper' ? 'SELL' : 'BUY';
        const { sl, target, qty } = fadePlan(action, close, orbHigh, orbLow, vwap, pb.breakoutHigh, pb.breakoutLow, cfg);
        const profitable = action === 'SELL' ? target < close : target > close;
        if (qty > 0 && profitable && Math.abs(close - sl) > 0) {
          lastSigIdx = i; dayTrades++;
          openTrade = { action, entry: close, sl, target, qty, entryIdx: i, entryTs: ts };
          continue;
        }
      }
    }

    // Detect a breakout ATTEMPT (to fade if it fails next candle)
    if (!inWindow) continue;
    if (dayTrades >= MAX_TRADES_PER_DAY) continue;
    if (i - lastSigIdx < COOLDOWN_CANDLES) continue;
    if ((high - low) / close < 0.002) continue;
    const orbRange = orbHigh - orbLow;
    if (ORB_MIN_RANGE_PCT > 0 && (orbRange / close * 100) < ORB_MIN_RANGE_PCT) continue;

    const avgVol = volHist.length > 1
      ? volHist.slice(0, -1).reduce((s, v) => s + v, 0) / (volHist.length - 1)
      : (volHist[0] ?? 0);
    const vm = (vol !== null && avgVol > 0) ? +(vol / avgVol).toFixed(2) : null;
    const hasSpike = vm != null && vm >= VOLUME_SPIKE_MIN;
    if (!hasSpike) continue;

    const upperAttempt = close > orbBufH && close > open;
    const lowerAttempt = close < orbBufL && close < open;
    if (!upperAttempt && !lowerAttempt) continue;

    pending = {
      side: upperAttempt ? 'upper' : 'lower',
      breakoutIdx: i, breakoutHigh: high, breakoutLow: low, entryTs: ts,
    };
  }

  if (openTrade && candles.length > 0) {
    const [lts, , , , lclose] = candles[candles.length - 1];
    const { action: a, entry, qty, entryTs } = openTrade;
    closeTrade(a, entry, lclose, qty, entryTs, lts, null, 'end-of-data');
  }
  return { trades, filtered: [] };
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

function metrics(trades, days) {
  if (trades.length === 0) return {
    trades: 0, wins: 0, losses: 0, winRate: 0, netPnL: 0, totalCosts: 0,
    profitFactor: 0, avgRR: 0, maxDrawdown: 0, tradesPerDay: 0,
    buyWR: 0, sellWR: 0, buys: 0, sells: 0,
    avgWin: 0, avgLoss: 0, slHits: 0, targetHits: 0,
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
    avgWin:       wins.length   > 0 ? +(wins.reduce((s, t) => s + t.profit, 0)   / wins.length).toFixed(2)   : 0,
    avgLoss:      losses.length > 0 ? +(losses.reduce((s, t) => s + t.profit, 0) / losses.length).toFixed(2) : 0,
    slHits:       trades.filter(t => t.result === 'LOSS').length,
    targetHits:   trades.filter(t => t.result === 'WIN').length,
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

const BASE = {
  MIN_CONFIDENCE:   68,
  VOLUME_SPIKE_MIN: 1.5,
  ORB_BUFFER_PCT:   0.10,
  ORB_MIN_RANGE_PCT: 0.30,
  ORB_CANDLES:      2,
  MAX_TRADES_PER_DAY: 2,
  COOLDOWN_CANDLES: 2,
  WINDOW_START_MINS: 9*60+30,
  ENTRY_CUTOFF_MINS: 14*60+30,
  CLOSE_ALL_MINS:   15*60+15,
  BULL_MARKET_THRESHOLD: 0.55,
  CAPITAL_PER_TRADE: 16_000,
  SL_PCT:           0.5,
  TARGET_MULT:      2.0,
  TARGET_PCT_FALLBACK: 1.0,
  CONFIRMATION:     true,        // confirmation candle (validated) kept in all
  SL_MODE:          'fixed',     // 'fixed' | 'structure'
  RISK_PER_TRADE:   null,        // null = capital sizing; number = risk-based ₹
};

// 1) CURRENT — validated confirmation strategy (the established baseline)
const CFG_CURRENT = { ...BASE };

// 2) STRUCT — replace fixed 0.5% SL with opposite-ORB-boundary SL + risk sizing
//    RISK_PER_TRADE ≈ baseline risk (16k × 0.5% = ₹80) so ₹ risk/trade stays comparable
const CFG_STRUCT = { ...BASE, SL_MODE: 'structure', RISK_PER_TRADE: 80 };

// 3) FADE combo — mean reversion on failed breakouts + structure stop (beyond
//    breakout extreme) + ₹80 risk sizing + a PROPER target (fixing the VWAP flaw).
const CFG_FADE_ORB = { ...BASE, RISK_PER_TRADE: 80, FADE_TARGET_MODE: 'orb_opposite' };
const CFG_FADE_15R = { ...BASE, RISK_PER_TRADE: 80, FADE_TARGET_MODE: 'rmult', FADE_R_MULT: 1.5 };
const CFG_FADE_2R  = { ...BASE, RISK_PER_TRADE: 80, FADE_TARGET_MODE: 'rmult', FADE_R_MULT: 2.0 };

const toDate   = new Date();
const fromDate = new Date(toDate);
fromDate.setDate(fromDate.getDate() - DAYS);
const fromStr  = fromDate.toISOString().slice(0, 10);
const toStr    = toDate.toISOString().slice(0, 10);

const RESULTS_PATH = path.resolve('/app/data/backtest-results.json');

async function main() {
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`  FADE COMBO TEST  |  ${fromStr} → ${toStr}  |  ${SYMBOLS.length} symbols`);
  console.log(`  A    = CURRENT baseline (momentum + confirmation + fixed SL)`);
  console.log(`  ORB  = Fade + structure stop + ₹80 risk + target: opposite ORB boundary`);
  console.log(`  1.5R = Fade + structure stop + ₹80 risk + target: 1.5× stop distance`);
  console.log(`  2R   = Fade + structure stop + ₹80 risk + target: 2.0× stop distance`);
  console.log(`${'═'.repeat(78)}\n`);

  const A = [], FO = [], F15 = [], F2 = [], symbolSummary = [];
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

    const a   = replayCandles(candles, sym, CFG_CURRENT).trades;  // identical real candles
    const fo  = replayFade(candles, sym, CFG_FADE_ORB).trades;
    const f15 = replayFade(candles, sym, CFG_FADE_15R).trades;
    const f2  = replayFade(candles, sym, CFG_FADE_2R).trades;
    A.push(...a); FO.push(...fo); F15.push(...f15); F2.push(...f2);
    const pnl = arr => +arr.reduce((s,t)=>s+t.profit,0).toFixed(2);
    symbolSummary.push({ symbol: sym,
      A: pnl(a), ORB: pnl(fo), R15: pnl(f15), R2: pnl(f2),
    });
  }

  const mA = metrics(A, DAYS), mFO = metrics(FO, DAYS), mF15 = metrics(F15, DAYS), mF2 = metrics(F2, DAYS);

  // ─── 4-way comparison table ──────────────────────────────────────────────
  console.log(`\n${'─'.repeat(78)}`);
  console.log(`  ${'Metric'.padEnd(15)} ${'A:CURRENT'.padStart(12)} ${'FADE-ORB'.padStart(12)} ${'FADE-1.5R'.padStart(12)} ${'FADE-2R'.padStart(12)}`);
  console.log(`${'─'.repeat(78)}`);
  const row = (k, va, vb, vc, vd) =>
    console.log(`  ${k.padEnd(15)} ${String(va).padStart(12)} ${String(vb).padStart(12)} ${String(vc).padStart(12)} ${String(vd).padStart(12)}`);
  row('Total Trades',  mA.trades,       mFO.trades,       mF15.trades,       mF2.trades);
  row('Win Rate %',    mA.winRate,      mFO.winRate,      mF15.winRate,      mF2.winRate);
  row('Net P&L ₹',     mA.netPnL,       mFO.netPnL,       mF15.netPnL,       mF2.netPnL);
  row('Profit Factor', mA.profitFactor, mFO.profitFactor, mF15.profitFactor, mF2.profitFactor);
  row('Avg R:R',       mA.avgRR,        mFO.avgRR,        mF15.avgRR,        mF2.avgRR);
  row('Max Drawdown',  mA.maxDrawdown,  mFO.maxDrawdown,  mF15.maxDrawdown,  mF2.maxDrawdown);
  row('Avg Win ₹',     mA.avgWin,       mFO.avgWin,       mF15.avgWin,       mF2.avgWin);
  row('Avg Loss ₹',    mA.avgLoss,      mFO.avgLoss,      mF15.avgLoss,      mF2.avgLoss);
  row('SL Hits',       mA.slHits,       mFO.slHits,       mF15.slHits,       mF2.slHits);
  row('Target Hits',   mA.targetHits,   mFO.targetHits,   mF15.targetHits,   mF2.targetHits);
  row('BUY WR %',      mA.buyWR,        mFO.buyWR,        mF15.buyWR,        mF2.buyWR);
  row('SELL WR %',     mA.sellWR,       mFO.sellWR,       mF15.sellWR,       mF2.sellWR);

  // ─── Per-symbol net P&L ─────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(78)}`);
  console.log(`  PER-SYMBOL NET P&L`);
  console.log(`${'─'.repeat(78)}`);
  console.log(`  ${'Symbol'.padEnd(13)} ${'CURRENT'.padStart(10)} ${'FADE-ORB'.padStart(10)} ${'FADE1.5R'.padStart(10)} ${'FADE-2R'.padStart(10)}`);
  for (const s of symbolSummary) {
    console.log(`  ${s.symbol.padEnd(13)} ${String(s.A).padStart(10)} ${String(s.ORB).padStart(10)} ${String(s.R15).padStart(10)} ${String(s.R2).padStart(10)}`);
  }

  // ─── Verdict ────────────────────────────────────────────────────────────────
  const variants = [
    { name: 'A:CURRENT',  m: mA },
    { name: 'FADE-ORB',   m: mFO },
    { name: 'FADE-1.5R',  m: mF15 },
    { name: 'FADE-2R',    m: mF2 },
  ];
  const winner = variants.slice().sort((x, y) => y.m.netPnL - x.m.netPnL)[0];
  console.log(`\n${'─'.repeat(78)}`);
  console.log(`  VERDICT`);
  console.log(`${'─'.repeat(78)}`);
  for (const v of variants) {
    const ok = v.m.netPnL > 0 && v.m.profitFactor > 1;
    const dailyPnL = v.m.trades > 0 ? +(v.m.netPnL / Math.max(DAYS*5/7,1)).toFixed(1) : 0;
    console.log(`  ${v.name.padEnd(12)} NetP&L ₹${String(v.m.netPnL).padStart(9)}  PF ${String(v.m.profitFactor).padStart(5)}  WR ${String(v.m.winRate).padStart(5)}%  ~₹${String(dailyPnL).padStart(6)}/day  ${ok ? '✓ PROFITABLE' : '✗'}`);
  }
  console.log(`\n  Best by Net P&L: ${winner.name} (₹${winner.m.netPnL}, PF ${winner.m.profitFactor})`);
  if (winner.m.netPnL > 0 && winner.m.profitFactor > 1) {
    console.log(`  → ${winner.name} shows positive expectancy. Recommend 120-day robustness check, then paper validation before any live change.`);
  } else {
    console.log(`  → Still no profitable variant. The fade direction has WR edge but R:R cannot overcome costs+losses here.`);
  }

  // ─── Persist ────────────────────────────────────────────────────────────────
  let existing = {};
  if (fs.existsSync(RESULTS_PATH)) {
    try { existing = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8')); } catch {}
  }
  const runId = `fade_combo_${fromStr}_${toStr}_${Date.now()}`;
  existing[runId] = {
    runAt: new Date().toISOString(),
    type: 'fade_combo_target_test',
    fromDate: fromStr, toDate: toStr, days: DAYS,
    symbols: SYMBOLS, fetched, failed,
    current:  { label: 'momentum baseline',          ...mA },
    fadeORB:  { label: 'fade + opposite-ORB target', ...mFO },
    fade15R:  { label: 'fade + 1.5R target',         ...mF15 },
    fade2R:   { label: 'fade + 2R target',           ...mF2 },
    symbolSummary,
    winner: winner.name,
  };
  const keys = Object.keys(existing);
  if (keys.length > 50) keys.sort().slice(0, keys.length - 50).forEach(k => delete existing[k]);
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(existing, null, 2));
  console.log(`\n  Results saved → data/backtest-results.json (runId: ${runId})`);
  console.log(`${'═'.repeat(78)}\n`);
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  if (err.response?.data) console.error('API response:', JSON.stringify(err.response.data));
  process.exit(1);
});

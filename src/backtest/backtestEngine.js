'use strict';

/**
 * Backtest Engine — Simple Intraday NSE Strategy
 *
 * Mirrors signalEngine.js exactly:
 *   Entry: Price > EMA20 + RSI > 55 + bullish candle + volume >= 1.3x  (BUY)
 *          Price < EMA20 + RSI < 45 + bearish candle + volume >= 1.3x  (SELL)
 *   Skip:  RSI 45–55 (neutral zone — no trade)
 *   SL:    fixed 0.3% from entry
 *   Target: fixed 0.8% from entry
 *   Force-close: 3:15 PM IST — ALL open trades exit at market price
 *   Max 1 trade per day per symbol
 *   No overnight holding. No trailing SL. No ATR logic.
 */

const axios = require('axios');

// ─── Instrument Tokens (NSE Equity — Nifty 50 stable tokens) ─────────────────

const INSTRUMENT_TOKENS = {
  RELIANCE:   738561,
  TCS:        2953217,
  INFY:       408065,
  HDFCBANK:   341249,
  ICICIBANK:  1270529,
  HINDUNILVR: 356865,
  SBIN:       779521,
  BHARTIARTL: 2714625,
  ITC:        424961,
  KOTAKBANK:  492033,
  LT:         2939649,
  AXISBANK:   1510401,
  BAJFINANCE: 4267265,
  WIPRO:      969473,
  ULTRACEMCO: 2952193,
  ASIANPAINT: 60417,
  MARUTI:     2815745,
  SUNPHARMA:  857857,
  TITAN:      897537,
  NESTLEIND:  4598529,
  ADANIENT:   25,
  ADANIPORTS: 3861249,
  APOLLOHOSP: 157001,
  BAJAJFINSV: 4268801,
  BPCL:       134657,
  BRITANNIA:  140033,
  CIPLA:      177665,
  COALINDIA:  5215745,
  DIVISLAB:   2800641,
  DRREDDY:    225537,
  EICHERMOT:  232961,
  GRASIM:     315393,
  HCLTECH:    1850625,
  HEROMOTOCO: 345089,
  HINDALCO:   348929,
  INDUSINDBK: 1346049,
  JSWSTEEL:   3001089,
  LTIM:       17818113,
  NTPC:       2977281,
  ONGC:       633601,
  POWERGRID:  3834113,
  SHRIRAMFIN: 4220929,
  TATACONSUM: 878593,
  TATAMOTORS: 884737,
  TATASTEEL:  895745,
  TECHM:      3465729,
  TRENT:      1964033,
};

// ─── Strategy Config ──────────────────────────────────────────────────────────

const MIN_CONFIDENCE     = 50;    // signal score threshold
const VOLUME_SPIKE_MIN   = 1.5;   // minimum volume multiplier
const SL_PCT             = 0.3;   // fixed stop loss: 0.3% from entry
const TARGET_PCT         = 0.8;   // fixed target:    0.8% from entry
const CAPITAL_PER_TRADE  = 20000; // fixed ₹20,000 capital per trade
const MAX_TRADES_PER_DAY = 1;     // max trades per symbol per day
const RSI_PERIOD         = 14;
const EMA_PERIOD         = 20;
const COOLDOWN_CANDLES   = 3;     // 3 × 5-min = 15 min between signals

const WINDOW_START_MINS  = 9 * 60 + 30;   // 570 = 9:30 AM IST
const ENTRY_CUTOFF_MINS  = 12 * 60 + 30;  // 750 = 12:30 PM IST (no new entries after)
const WINDOW_END_MINS    = 15 * 60 + 15;  // 915 = 3:15 PM IST
const CLOSE_ALL_MINS     = 15 * 60 + 15;  // force-close ALL trades at 3:15 PM

// ─── Trading cost model (Zerodha NSE equity intraday) ────────────────────────

const SLIPPAGE_PCT   = 0.10;    // 0.10% per side
const BROKERAGE_PCT  = 0.03;    // 0.03% per side (Zerodha intraday equity)
const BROKERAGE_CAP  = 20;      // ₹20 per-order cap
const STT_PCT        = 0.025;   // 0.025% on sell-side turnover
const EXCHANGE_PCT   = 0.00325; // NSE exchange transaction charges per side

function calcTradingCosts(action, entryPrice, exitPrice, qty) {
  const entryVal = entryPrice * qty;
  const exitVal  = exitPrice  * qty;

  const slippage   = (entryVal + exitVal) * (SLIPPAGE_PCT  / 100);
  const brokEntry  = Math.min(entryVal * (BROKERAGE_PCT / 100), BROKERAGE_CAP);
  const brokExit   = Math.min(exitVal  * (BROKERAGE_PCT / 100), BROKERAGE_CAP);
  const sellVal    = action === 'BUY' ? exitVal : entryVal;
  const stt        = sellVal * (STT_PCT / 100);
  const exchCharges = (entryVal + exitVal) * (EXCHANGE_PCT / 100);
  const gst        = (brokEntry + brokExit + exchCharges) * 0.18;

  return parseFloat((slippage + brokEntry + brokExit + stt + exchCharges + gst).toFixed(2));
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function computeRSI(prices) {
  if (!prices || prices.length < RSI_PERIOD + 1) return null;
  let gains = 0, losses = 0;
  const slice = prices.slice(-(RSI_PERIOD + 1));
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff > 0) gains  += diff;
    else          losses -= diff;
  }
  const avgGain = gains  / RSI_PERIOD;
  const avgLoss = losses / RSI_PERIOD;
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(1));
}

function computeEMA(prices, period) {
  if (prices.length === 0) return 0;
  const k  = 2 / (period + 1);
  let   em = prices[0];
  for (let i = 1; i < prices.length; i++) {
    em = prices[i] * k + em * (1 - k);
  }
  return parseFloat(em.toFixed(2));
}

function getCandleMins(ts) {
  const d   = new Date(ts);
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function isWithinWindow(ts) {
  const mins = getCandleMins(ts);
  return mins >= WINDOW_START_MINS && mins <= WINDOW_END_MINS;
}

// ─── Simple scoring (matches signalEngine.js) ─────────────────────────────────

function scoreSignal(action, rsi, volumeMultiplier, price, vwap) {
  let score = 40; // base: all 4 gates cleared

  // RSI quality
  if (action === 'BUY') {
    if (rsi !== null && rsi >= 60) score += 20;
    else if (rsi !== null && rsi >= 50) score += 10;
  } else {
    if (rsi !== null && rsi <= 40) score += 20;
    else if (rsi !== null && rsi < 50) score += 10;
  }

  // Volume quality
  if (volumeMultiplier != null) {
    if      (volumeMultiplier >= 3.0) score += 20;
    else if (volumeMultiplier >= 2.0) score += 15;
    else if (volumeMultiplier >= 1.5) score += 8;
  }

  // VWAP alignment
  if (vwap != null) {
    const aligned = (action === 'BUY' && price > vwap) ||
                    (action === 'SELL' && price < vwap);
    if (aligned) score += 20;
  }

  return Math.min(score, 100);
}

// ─── Data Fetching ────────────────────────────────────────────────────────────

async function fetchHistoricalCandles(symbol, fromDate, toDate) {
  const token = INSTRUMENT_TOKENS[symbol.toUpperCase()];
  if (!token) {
    throw new Error(`No instrument token for "${symbol}". Supported: ${Object.keys(INSTRUMENT_TOKENS).join(', ')}`);
  }

  const url = `https://api.kite.trade/instruments/historical/${token}/5minute` +
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
    throw new Error(`No candles returned for ${symbol} (${fromDate} – ${toDate})`);
  }
  return candles;
}

function generateSyntheticCandles(symbol, fromDate, toDate, basePrice) {
  const SEED_PRICES = {
    RELIANCE: 1280, TCS: 3500, INFY: 1750, HDFCBANK: 1620, ICICIBANK: 1300,
    HINDUNILVR: 2450, SBIN: 780, BHARTIARTL: 1780, ITC: 465, KOTAKBANK: 1920,
    LT: 3650, AXISBANK: 1180, BAJFINANCE: 6800, WIPRO: 270, ULTRACEMCO: 10800,
    ASIANPAINT: 2280, MARUTI: 12200, SUNPHARMA: 1680, TITAN: 3380, NESTLEIND: 2250,
    ADANIENT: 2400, ADANIPORTS: 1350, APOLLOHOSP: 7150, BAJAJFINSV: 1680,
    BPCL: 285, BRITANNIA: 5200, CIPLA: 1480, COALINDIA: 420, DIVISLAB: 5350,
    DRREDDY: 6780, EICHERMOT: 4800, GRASIM: 2650, HCLTECH: 1700, HEROMOTOCO: 4200,
    HINDALCO: 680, INDUSINDBK: 955, JSWSTEEL: 960, LTIM: 5200, NTPC: 345,
    ONGC: 265, POWERGRID: 325, SHRIRAMFIN: 650, TATACONSUM: 1050, TATAMOTORS: 780,
    TATASTEEL: 145, TECHM: 1520, TRENT: 5800,
  };

  const seed    = basePrice || SEED_PRICES[symbol.toUpperCase()] || 1000;
  const candles = [];
  const cur     = new Date(`${fromDate}T04:00:00.000Z`); // 09:30 IST = 04:00 UTC
  const end     = new Date(`${toDate}T10:00:00.000Z`);   // 15:30 IST = 10:00 UTC
  let price = seed;

  while (cur <= end) {
    const istDay = new Date(cur.getTime() + 5.5 * 60 * 60 * 1000).getUTCDay();
    if (istDay === 0 || istDay === 6) {
      cur.setUTCDate(cur.getUTCDate() + 1);
      cur.setUTCHours(4, 0, 0, 0);
      continue;
    }

    const dayEnd = new Date(cur.getTime());
    dayEnd.setUTCHours(10, 0, 0, 0);

    for (let i = 0; i < 75; i++) {
      const ts = new Date(cur.getTime() + i * 5 * 60_000);
      if (ts > dayEnd) break;

      const drift    = (seed - price) * 0.0005;
      const noise    = price * 0.003 * (Math.random() - 0.48);
      const close    = Math.max(price * 0.95, price + drift + noise);
      const bodySize = Math.abs(close - price);
      const wick     = bodySize * (0.3 + Math.random() * 0.5);

      const high    = Math.max(price, close) + wick;
      const low     = Math.min(price, close) - wick * 0.6;
      const baseVol = 50_000 + Math.random() * 150_000;
      const volume  = Math.random() < 0.125 ? baseVol * (2 + Math.random() * 3) : baseVol;

      candles.push([
        ts.toISOString(),
        parseFloat(price.toFixed(2)),
        parseFloat(high.toFixed(2)),
        parseFloat(low.toFixed(2)),
        parseFloat(close.toFixed(2)),
        Math.round(volume),
      ]);
      price = close;
    }

    cur.setUTCDate(cur.getUTCDate() + 1);
    cur.setUTCHours(4, 0, 0, 0);
  }

  return candles;
}

// ─── Core Replay Engine ───────────────────────────────────────────────────────

/**
 * Replay 5-min candles and simulate intraday trades.
 * Simple logic: 4-condition entry, fixed SL/target, force-close 3:15 PM.
 *
 * @param {Array}  candles  [[ts, open, high, low, close, volume], ...]
 * @param {string} symbol
 * @returns {Array<Object>}  completed trades
 */
function replayCandles(candles, symbol) {
  const trades = [];

  // Per-replay state
  const closeHistory  = [];  // for RSI (max 60)
  const emaHistory    = [];  // for EMA20 (max 100)
  const volumeHistory = [];  // rolling avg volume (max 20)

  let vwapAccum    = 0;
  let vwapVol      = 0;
  let currentDay   = '';
  let lastSignalIdx = -999;
  let openTrade    = null;
  let pendingEntry  = null;   // signal awaiting next-candle confirmation
  let prevHigh     = null;   // previous candle high (for breakout confirmation)
  let prevLow      = null;   // previous candle low

  // Daily counters (reset each day)
  let dailyTradeCount = 0;
  let dailyTradeDay  = '';

  for (let i = 0; i < candles.length; i++) {
    const [ts, open, high, low, close, rawVol] = candles[i];
    const volume     = (typeof rawVol === 'number' && isFinite(rawVol) && rawVol > 0) ? rawVol : null;
    const candleMins = getCandleMins(ts);
    const candleDate = ts.slice(0, 10);
    const prevCandleHigh = prevHigh;
    const prevCandleLow  = prevLow;
    prevHigh = high;
    prevLow  = low;

    // ── Day boundary reset ───────────────────────────────────────────────────
    if (candleDate !== currentDay) {
      vwapAccum    = 0;
      vwapVol      = 0;
      currentDay   = candleDate;
      pendingEntry = null;   // new day — discard any pending signal

      if (dailyTradeDay !== candleDate) {
        dailyTradeCount = 0;
        dailyTradeDay   = candleDate;
      }

      // Force-close any overnight carry (should never happen with 3:15 PM exit,
      // but safety net in case of bad data ordering)
      if (openTrade) {
        const { action, entry, sl, target, qty, entryTs, entryIdx } = openTrade;
        const grossProfit = action === 'BUY' ? (open - entry) * qty : (entry - open) * qty;
        const cost        = calcTradingCosts(action, entry, open, qty);
        const netProfit   = parseFloat((grossProfit - cost).toFixed(2));
        trades.push({
          symbol, action,
          entry:       parseFloat(entry.toFixed(2)),
          exit:        parseFloat(open.toFixed(2)),
          stopLoss:    parseFloat(sl.toFixed(2)),
          target:      parseFloat(target.toFixed(2)),
          qty,
          grossProfit: parseFloat(grossProfit.toFixed(2)),
          tradingCost: cost,
          profit:      netProfit,
          result:      netProfit >= 0 ? 'WIN' : 'LOSS',
          entryTime:   entryTs,
          exitTime:    ts,
          holdCandles: i - entryIdx,
          note:        'overnight-safety-close',
        });
        openTrade = null;
      }
    }

    // ── VWAP accumulation ────────────────────────────────────────────────────
    const typicalPrice = (high + low + close) / 3;
    if (volume !== null) { vwapAccum += typicalPrice * volume; vwapVol += volume; }
    const vwap = vwapVol > 0 ? vwapAccum / vwapVol : null;

    // ── History updates ──────────────────────────────────────────────────────
    closeHistory.push(close);
    if (closeHistory.length > 60) closeHistory.shift();

    emaHistory.push(close);
    if (emaHistory.length > 100) emaHistory.shift();

    if (volume !== null) {
      volumeHistory.push(volume);
      if (volumeHistory.length > 20) volumeHistory.shift();
    }

    // ── Open trade management ────────────────────────────────────────────────
    if (openTrade) {
      const { action, entry, sl, target, qty, entryTs, entryIdx } = openTrade;

      // 1. Force-close at 3:15 PM
      if (candleMins >= CLOSE_ALL_MINS) {
        const exitPrice   = close;
        const grossProfit = action === 'BUY' ? (exitPrice - entry) * qty : (entry - exitPrice) * qty;
        const cost        = calcTradingCosts(action, entry, exitPrice, qty);
        const netProfit   = parseFloat((grossProfit - cost).toFixed(2));
        console.log(`[BT:${symbol}] ${ts.slice(0,16).replace('T',' ')} CLOSE-ALL  ${action} exit=₹${exitPrice.toFixed(2)} pnl=₹${netProfit}`);
        trades.push({
          symbol, action,
          entry:       parseFloat(entry.toFixed(2)),
          exit:        parseFloat(exitPrice.toFixed(2)),
          stopLoss:    parseFloat(sl.toFixed(2)),
          target:      parseFloat(target.toFixed(2)),
          qty,
          grossProfit: parseFloat(grossProfit.toFixed(2)),
          tradingCost: cost,
          profit:      netProfit,
          result:      netProfit >= 0 ? 'WIN' : 'LOSS',
          entryTime:   entryTs,
          exitTime:    ts,
          holdCandles: i - entryIdx,
          note:        '3:15 PM squareoff',
        });
        openTrade = null;
        continue;
      }

      // 2. SL hit
      const slHit = (action === 'BUY' && low <= sl) || (action === 'SELL' && high >= sl);
      // 3. Target hit
      const tgtHit = (action === 'BUY' && high >= target) || (action === 'SELL' && low <= target);

      if (slHit || tgtHit) {
        const exitPrice   = slHit ? sl : target;
        const tradeResult = slHit ? 'LOSS' : 'WIN';
        const grossProfit = action === 'BUY' ? (exitPrice - entry) * qty : (entry - exitPrice) * qty;
        const cost        = calcTradingCosts(action, entry, exitPrice, qty);
        const netProfit   = parseFloat((grossProfit - cost).toFixed(2));
        console.log(`[BT:${symbol}] ${ts.slice(0,16).replace('T',' ')} ${tradeResult}  ${action} exit=₹${exitPrice.toFixed(2)} pnl=₹${netProfit}`);
        trades.push({
          symbol, action,
          entry:       parseFloat(entry.toFixed(2)),
          exit:        parseFloat(exitPrice.toFixed(2)),
          stopLoss:    parseFloat(sl.toFixed(2)),
          target:      parseFloat(target.toFixed(2)),
          qty,
          grossProfit: parseFloat(grossProfit.toFixed(2)),
          tradingCost: cost,
          profit:      netProfit,
          result:      tradeResult,
          entryTime:   entryTs,
          exitTime:    ts,
          holdCandles: i - entryIdx,
        });
        openTrade = null;
      }

      // Skip signal generation while in a trade
      if (openTrade) continue;
    }

    // ── Pending entry confirmation (from previous candle signal) ──────────────────
    if (pendingEntry) {
      const { action: pAction } = pendingEntry;
      const confirmed = (pAction === 'BUY'  && close > open) ||
                        (pAction === 'SELL' && close < open);
      if (confirmed && dailyTradeCount < MAX_TRADES_PER_DAY && candleMins < ENTRY_CUTOFF_MINS) {
        const newSl     = pAction === 'BUY'
          ? parseFloat((close * (1 - SL_PCT / 100)).toFixed(2))
          : parseFloat((close * (1 + SL_PCT / 100)).toFixed(2));
        const newTarget = pAction === 'BUY'
          ? parseFloat((close * (1 + TARGET_PCT / 100)).toFixed(2))
          : parseFloat((close * (1 - TARGET_PCT / 100)).toFixed(2));
        const newQty    = Math.floor(CAPITAL_PER_TRADE / close);
        if (newQty > 0) {
          dailyTradeCount++;
          openTrade = { action: pAction, entry: close, sl: newSl, target: newTarget, qty: newQty, entryIdx: i, entryTs: ts };
          console.log(`[BT:${symbol}] ${ts.slice(0,16).replace('T',' ')} ${pAction} CONFIRMED entry=₹${close} sl=₹${newSl} target=₹${newTarget} qty=${newQty}`);
        }
      } else {
        console.log(`[BT:${symbol}] ${ts.slice(0,16).replace('T',' ')} ${pAction} MISSED confirmation — next candle not ${pAction === 'BUY' ? 'bullish' : 'bearish'} (close=₹${close.toFixed(2)} open=₹${open.toFixed(2)})`);
      }
      pendingEntry = null;
      if (openTrade) continue; // just opened — skip signal search
    }

    // ── Skip signal generation outside trading window ────────────────────────
    if (!isWithinWindow(ts)) continue;

    // ── Daily limits ─────────────────────────────────────────────────────────
    if (dailyTradeCount >= MAX_TRADES_PER_DAY) continue;

    // No new entries after 2:30 PM
    if (candleMins >= ENTRY_CUTOFF_MINS) continue;

    // ── Cooldown ─────────────────────────────────────────────────────────────
    if (i - lastSignalIdx < COOLDOWN_CANDLES) continue;

    // ── Avoid sideways (candle range < 0.2% of price) ────────────────────────
    if ((high - low) / close < 0.002) continue;

    // ── Indicators ───────────────────────────────────────────────────────────
    const rsi   = computeRSI(closeHistory);
    const ema20 = computeEMA(emaHistory.slice(-60), EMA_PERIOD);

    const avgVolume = volumeHistory.length > 1
      ? volumeHistory.slice(0, -1).reduce((s, v) => s + v, 0) / (volumeHistory.length - 1)
      : (volumeHistory[0] ?? 0);
    const volumeMultiplier = (volume !== null && avgVolume > 0)
      ? parseFloat((volume / avgVolume).toFixed(2))
      : null;

    // ── Entry gates (same 4 conditions as signalEngine.js) ───────────────────
    const priceAboveEMA  = close > ema20;
    const priceBelowEMA  = close < ema20;
    const rsiAbove58     = rsi !== null && rsi > 58;
    const rsiBelow42     = rsi !== null && rsi < 42;
    const rsiNeutral     = rsi !== null && rsi >= 42 && rsi <= 58;
    const bullishCandle  = close > open;
    const bearishCandle  = close < open;
    const hasVolumeSpike = volumeMultiplier != null && volumeMultiplier >= VOLUME_SPIKE_MIN;

    // Skip RSI neutral zone (42–58) — no clear directional bias
    if (rsiNeutral) continue;

    const isBuy  = priceAboveEMA && rsiAbove58 && bullishCandle && hasVolumeSpike;
    const isSell = priceBelowEMA && rsiBelow42 && bearishCandle && hasVolumeSpike;

    if (!isBuy && !isSell) {
      // Only log occasionally to avoid flood
      continue;
    }

    const action = isBuy ? 'BUY' : 'SELL';
    const score  = scoreSignal(action, rsi, volumeMultiplier, close, vwap ? parseFloat(vwap.toFixed(2)) : null);

    if (score < MIN_CONFIDENCE) {
      console.log('REJECT:', { symbol, reason: 'low-score', score, minRequired: MIN_CONFIDENCE, volumeMultiplier, rsi: rsi?.toFixed(1), ema20: ema20?.toFixed(2), close });
      continue;
    }

    // ── Fixed SL and target ──────────────────────────────────────────────────
    const sl = action === 'BUY'
      ? parseFloat((close * (1 - SL_PCT / 100)).toFixed(2))
      : parseFloat((close * (1 + SL_PCT / 100)).toFixed(2));
    const target = action === 'BUY'
      ? parseFloat((close * (1 + TARGET_PCT / 100)).toFixed(2))
      : parseFloat((close * (1 - TARGET_PCT / 100)).toFixed(2));

    // ── Fixed position size: ₹20,000 per trade ──────────────────────────
    const qty = Math.floor(CAPITAL_PER_TRADE / close);

    if (qty <= 0) continue;

    // ── Check cost viability ─────────────────────────────────────────────────
    const expectedGross = Math.abs(target - close) * qty;
    const expectedCost  = calcTradingCosts(action, close, target, qty);
    if (expectedGross <= expectedCost) {
      console.log('REJECT:', { symbol, reason: 'cost-too-high', expectedProfit: expectedGross.toFixed(0), expectedCost: expectedCost.toFixed(0), qty, score });
      continue;
    }

    // ── Signal detected → await next-candle confirmation ───────────────────────
    lastSignalIdx = i;   // set cooldown now so no second signal fires while waiting
    pendingEntry  = { action, score };
    console.log(`[BT:${symbol}] ${ts.slice(0,16).replace('T',' ')} ${action} SIGNAL  close=₹${close.toFixed(2)} score=${score} — awaiting ${action === 'BUY' ? 'bullish' : 'bearish'} confirmation candle`);
  }

  // ── If any trade still open at end of data, force-close at last close ────────
  if (openTrade && candles.length > 0) {
    const [lts, , , , lclose] = candles[candles.length - 1];
    const { action, entry, sl, target, qty, entryTs, entryIdx } = openTrade;
    const grossProfit = action === 'BUY' ? (lclose - entry) * qty : (entry - lclose) * qty;
    const cost        = calcTradingCosts(action, entry, lclose, qty);
    const netProfit   = parseFloat((grossProfit - cost).toFixed(2));
    trades.push({
      symbol, action,
      entry:       parseFloat(entry.toFixed(2)),
      exit:        parseFloat(lclose.toFixed(2)),
      stopLoss:    parseFloat(sl.toFixed(2)),
      target:      parseFloat(target.toFixed(2)),
      qty,
      grossProfit: parseFloat(grossProfit.toFixed(2)),
      tradingCost: cost,
      profit:      netProfit,
      result:      netProfit >= 0 ? 'WIN' : 'LOSS',
      entryTime:   entryTs,
      exitTime:    lts,
      holdCandles: candles.length - 1 - entryIdx,
      note:        'end-of-data force-close',
    });
  }

  return trades;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

/**
 * Compute performance metrics including per-day breakdown.
 * @param {Array<Object>} trades
 * @returns {Object}
 */
function computeMetrics(trades) {
  if (trades.length === 0) {
    return {
      totalTrades: 0, winningTrades: 0, losingTrades: 0,
      winRate: 0, totalProfit: 0, totalCosts: 0, maxDrawdown: 0,
      avgRiskReward: 0, equityCurve: [], dailyStats: [],
    };
  }

  const wins    = trades.filter((t) => t.result === 'WIN');
  const losses  = trades.filter((t) => t.result === 'LOSS');

  const totalProfit = parseFloat(trades.reduce((s, t) => s + t.profit, 0).toFixed(2));
  const totalCosts  = parseFloat(trades.reduce((s, t) => s + (t.tradingCost || 0), 0).toFixed(2));

  // Max drawdown
  let peak = 0, cumPnL = 0, drawdown = 0;
  for (const t of trades) {
    cumPnL += t.profit;
    if (cumPnL > peak) peak = cumPnL;
    const dd = peak - cumPnL;
    if (dd > drawdown) drawdown = dd;
  }

  // Average R:R
  const rrList = trades.map((t) => {
    const riskPts   = Math.abs(t.entry - t.stopLoss);
    const rewardPts = Math.abs(t.exit - t.entry);
    return riskPts > 0 ? rewardPts / riskPts : 0;
  });
  const avgRiskReward = trades.length > 0
    ? parseFloat((rrList.reduce((s, r) => s + r, 0) / rrList.length).toFixed(2))
    : 0;

  // Equity curve (sorted by exitTime)
  const sorted = [...trades].sort((a, b) => new Date(a.exitTime) - new Date(b.exitTime));
  let running = 0;
  const equityCurve = sorted.map((t) => {
    running += t.profit;
    return {
      time:      t.exitTime,
      symbol:    t.symbol,
      action:    t.action,
      result:    t.result,
      profit:    parseFloat(t.profit.toFixed(2)),
      cumProfit: parseFloat(running.toFixed(2)),
    };
  });

  // Per-day breakdown: daily profit, trades, win rate, costs
  const dayMap = {};
  for (const t of trades) {
    const day = t.exitTime ? t.exitTime.slice(0, 10) : t.entryTime.slice(0, 10);
    if (!dayMap[day]) dayMap[day] = { trades: 0, wins: 0, profit: 0, costs: 0 };
    dayMap[day].trades++;
    if (t.result === 'WIN') dayMap[day].wins++;
    dayMap[day].profit += t.profit;
    dayMap[day].costs  += t.tradingCost || 0;
  }
  const dailyStats = Object.entries(dayMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      date,
      trades:  d.trades,
      wins:    d.wins,
      losses:  d.trades - d.wins,
      winRate: parseFloat(((d.wins / d.trades) * 100).toFixed(1)),
      profit:  parseFloat(d.profit.toFixed(2)),
      costs:   parseFloat(d.costs.toFixed(2)),
    }));

  return {
    totalTrades:   trades.length,
    winningTrades: wins.length,
    losingTrades:  losses.length,
    winRate:       trades.length > 0
      ? parseFloat(((wins.length / trades.length) * 100).toFixed(1))
      : 0,
    totalProfit,
    totalCosts,
    maxDrawdown:   parseFloat((-drawdown).toFixed(2)),
    avgRiskReward,
    equityCurve,
    dailyStats,
  };
}

// ─── Main Entry ───────────────────────────────────────────────────────────────

async function runBacktest(symbol, days = 7) {
  const ticker   = symbol.toUpperCase().replace('NSE:', '');
  const safeDays = Math.min(Math.max(parseInt(days, 10) || 7, 1), 60);

  const toDate   = new Date();
  const fromDate = new Date(toDate);
  fromDate.setDate(fromDate.getDate() - safeDays);
  const fromStr = fromDate.toISOString().slice(0, 10);
  const toStr   = toDate.toISOString().slice(0, 10);

  const hasCredentials = !!(process.env.ZERODHA_API_KEY && process.env.ZERODHA_ACCESS_TOKEN);

  let candles, dataSource;
  if (hasCredentials) {
    try {
      console.log(`[Backtest] Fetching ${safeDays}d of ${ticker} 5-min candles from Zerodha...`);
      candles    = await fetchHistoricalCandles(ticker, fromStr, toStr);
      dataSource = 'zerodha';
      console.log(`[Backtest] ${candles.length} candles fetched.`);
    } catch (err) {
      console.warn(`[Backtest] Zerodha fetch failed (${err.message}). Using synthetic data.`);
      candles    = generateSyntheticCandles(ticker, fromStr, toStr);
      dataSource = 'synthetic_fallback';
    }
  } else {
    console.log(`[Backtest] No Zerodha credentials — using synthetic data.`);
    candles    = generateSyntheticCandles(ticker, fromStr, toStr);
    dataSource = 'synthetic';
  }

  if (candles.length === 0) {
    return {
      symbol: ticker, fromDate: fromStr, toDate: toStr, dataSource,
      totalTrades: 0, winRate: 0, totalProfit: 0, trades: [],
      note: 'No candle data for the requested range.',
    };
  }

  console.log(`[Backtest] Replaying ${candles.length} candles for ${ticker}...`);
  const trades  = replayCandles(candles, ticker);
  const metrics = computeMetrics(trades);

  console.log(
    `[Backtest] ${ticker}: ${metrics.totalTrades} trades | ` +
    `winRate ${metrics.winRate}% | P&L ₹${metrics.totalProfit} | costs ₹${metrics.totalCosts}`
  );

  if (metrics.totalTrades < 5) {
    console.warn(`[Backtest] WARNING: ${ticker} generated only ${metrics.totalTrades} trades — insufficient trades for evaluation`);
  }

  return {
    symbol:    ticker,
    fromDate:  fromStr,
    toDate:    toStr,
    days:      safeDays,
    candles:   candles.length,
    dataSource,
    strategy: {
      slPct:           SL_PCT,
      targetPct:       TARGET_PCT,
      minConfidence:   MIN_CONFIDENCE,
      volumeSpikeMin:  VOLUME_SPIKE_MIN,
      maxTradesPerDay: MAX_TRADES_PER_DAY,
      cooldownMinutes: COOLDOWN_CANDLES * 5,
      capitalPerTrade: CAPITAL_PER_TRADE,
    },
    ...metrics,
    trades,
  };
}

// ─── Portfolio Backtest ───────────────────────────────────────────────────────

const PORTFOLIO_SYMBOLS = ['RELIANCE', 'TCS'];

async function runPortfolioBacktest(symbols = PORTFOLIO_SYMBOLS, days = 7) {
  const safeDays = Math.min(Math.max(parseInt(days, 10) || 7, 1), 60);
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

  const valid      = results.filter(Boolean);
  const perSymbol  = valid.map(({ trades: _t, equityCurve: _eq, dailyStats: _ds, ...rest }) => rest);
  const allTrades  = valid.flatMap((r) => r.trades || []);
  allTrades.sort((a, b) => new Date(a.entryTime) - new Date(b.entryTime));

  const portfolioMetrics = computeMetrics(allTrades);

  console.log(
    `[Portfolio] Done — ${portfolioMetrics.totalTrades} trades across ${valid.length} symbols | ` +
    `winRate ${portfolioMetrics.winRate}% | P&L ₹${portfolioMetrics.totalProfit} | ` +
    `costs ₹${portfolioMetrics.totalCosts}`
  );

  if (portfolioMetrics.totalTrades < 5) {
    console.warn(`[Portfolio] WARNING: only ${portfolioMetrics.totalTrades} total trades — insufficient trades for evaluation`);
  }

  return {
    symbols:    tickers,
    days:       safeDays,
    symbolsRun: valid.length,
    strategy: {
      slPct:           SL_PCT,
      targetPct:       TARGET_PCT,
      minConfidence:   MIN_CONFIDENCE,
      volumeSpikeMin:  VOLUME_SPIKE_MIN,
      maxTradesPerDay: MAX_TRADES_PER_DAY,
      capitalPerSymbol: CAPITAL_PER_TRADE,
      slippagePct:     SLIPPAGE_PCT,
      brokeragePct:    BROKERAGE_PCT,
    },
    ...portfolioMetrics,
    perSymbol,
    trades: allTrades,
  };
}

module.exports = { runBacktest, runPortfolioBacktest };

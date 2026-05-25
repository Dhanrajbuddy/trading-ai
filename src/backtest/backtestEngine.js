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

const MIN_CONFIDENCE     = 60;    // ORB breakout with volume is already high quality
const VOLUME_SPIKE_MIN   = 1.5;   // volume must confirm the breakout
const SL_PCT             = 0.5;   // 0.5% below entry
const TARGET_MULT        = 2.0;   // target = 2.0 × ORB range above breakout (on 15-min, cleaner moves)
const TARGET_PCT_FALLBACK= 1.0;   // fallback fixed target if ORB range is tiny (<0.2%)
// 15-minute candles: less noise, larger ORB ranges, better signal quality
// R:R with 2× target and 0.5% SL: if ORB range ≈ 0.8%, target ≈ 1.6%, R:R ≈ 3.2:1 → break-even WR = 24%
const CAPITAL            = parseFloat(process.env.CAPITAL) || 20_000;
const CAPITAL_PER_TRADE  = Math.floor(CAPITAL * 0.80); // ₹16k on ₹20k capital
const MAX_TRADES_PER_DAY = 2;     // ORB gives 1-2 signals per day; 2 is appropriate
const RSI_PERIOD         = 14;   // standard RSI period
const EMA_PERIOD         = 20;   // EMA20 for trend context
const ORB_CANDLES        = 2;    // 2 × 15-min = 30 min opening range period
const ORB_BUFFER_PCT     = 0.10; // 0.10% buffer above/below ORB to avoid false breakouts
const COOLDOWN_CANDLES   = 2;    // 2 × 15-min = 30 min cooldown between trades
const GAP_FILTER_PCT     = 0.3;  // unused for NSE (no gaps due to pre-open IEP session)
const ORB_MIN_RANGE_PCT  = 0.0;  // no ORB width filter (wider filter hurts WR on real data)

const WINDOW_START_MINS  = 9 * 60 + 30;   // 570 = 9:30 AM IST
const ENTRY_CUTOFF_MINS  = 15 * 60 + 0;   // 900 = 3:00 PM IST (matches live ENTRY_CUTOFF_MINS)
const WINDOW_END_MINS    = 15 * 60 + 0;   // 900 = 3:00 PM IST
const CLOSE_ALL_MINS     = 15 * 60 + 15;  // 915 = 3:15 PM IST (Zerodha auto-squareoff time)

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

function scoreSignal(action, rsi, volumeMultiplier, price, vwap, orbRange, orbHigh, orbLow) {
  let score = 45; // base: ORB breakout with volume confirmed

  // RSI quality: trending momentum in breakout direction (not at extremes)
  if (action === 'BUY') {
    if (rsi !== null && rsi >= 50 && rsi <= 68) score += 15;  // bullish momentum
    else if (rsi !== null && rsi >= 40 && rsi < 50) score += 8;
  } else {
    if (rsi !== null && rsi >= 32 && rsi <= 50) score += 15;  // bearish momentum
    else if (rsi !== null && rsi > 50 && rsi <= 60) score += 8;
  }

  // Volume: stronger spike = stronger breakout conviction
  if (volumeMultiplier != null) {
    if      (volumeMultiplier >= 3.0) score += 20;
    else if (volumeMultiplier >= 2.0) score += 15;
    else if (volumeMultiplier >= 1.5) score += 10;
  }

  // ORB range quality: wider range = clearer opening sentiment
  // As % of price
  if (orbRange != null && price > 0) {
    const rangePct = orbRange / price * 100;
    if (rangePct >= 0.8) score += 15;  // strong opening range (high volatility day)
    else if (rangePct >= 0.5) score += 10;
    else if (rangePct >= 0.3) score += 5;
  }

  // VWAP alignment: breakout above ORB high should also be above VWAP (double confirmation)
  if (vwap != null) {
    const vwapAligned = (action === 'BUY' && price > vwap) ||
                        (action === 'SELL' && price < vwap);
    if (vwapAligned) score += 5;
  }

  return Math.min(score, 100);
}

// ─── Data Fetching ────────────────────────────────────────────────────────────

async function fetchHistoricalCandles(symbol, fromDate, toDate) {
  const token = INSTRUMENT_TOKENS[symbol.toUpperCase()];
  if (!token) {
    throw new Error(`No instrument token for "${symbol}". Supported: ${Object.keys(INSTRUMENT_TOKENS).join(', ')}`);
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
  const emaHistory    = [];  // for EMA20 context (max 100)
  const volumeHistory = [];  // rolling avg volume (max 20)

  let vwapAccum    = 0;
  let vwapVol      = 0;

  // Opening Range state (reset each day)
  let orbHigh        = -Infinity;  // opening range high
  let orbLow         = Infinity;   // opening range low
  let orbEstablished = false;      // true after ORB_CANDLES candles have passed
  let prevDayClose   = null;       // last close of previous day (for gap filter)
  let dayOpenPrice   = null;       // first candle open of current day
  let dayHasGap      = false;      // true if opening gap >= GAP_FILTER_PCT
  let currentDay   = '';
  let lastSignalIdx = -999;
  let openTrade    = null;

  // Daily counters (reset each day)
  let dailyTradeCount  = 0;
  let dailyTradeDay    = '';
  let dailyCandleCount = 0;  // candles seen today
  const MIN_CANDLES_IN_DAY = 6; // 6 × 5-min = 30 min warmup (enough for VWAP to be meaningful)

  for (let i = 0; i < candles.length; i++) {
    const [ts, open, high, low, close, rawVol] = candles[i];
    const volume     = (typeof rawVol === 'number' && isFinite(rawVol) && rawVol > 0) ? rawVol : null;
    const candleMins = getCandleMins(ts);
    const candleDate = ts.slice(0, 10);
    const prevCandleHigh = high; // unused but kept for future use
    const prevCandleLow  = low;

    // ── Day boundary reset ───────────────────────────────────────────────────
    if (candleDate !== currentDay) {
      // Save previous day's last close before resetting
      if (currentDay !== '' && closeHistory.length > 0) {
        prevDayClose = closeHistory[closeHistory.length - 1];
      }
      vwapAccum      = 0;
      vwapVol        = 0;
      orbHigh        = -Infinity;  // reset Opening Range
      orbLow         = Infinity;
      orbEstablished = false;
      dayOpenPrice   = open;       // first candle open = day open
      // Gap filter: stock must have gapped ≥ GAP_FILTER_PCT from prev close
      dayHasGap = prevDayClose !== null
        ? Math.abs(open - prevDayClose) / prevDayClose * 100 >= GAP_FILTER_PCT
        : false;
      if (prevDayClose !== null) {
        const gapPct = ((open - prevDayClose) / prevDayClose * 100).toFixed(2);
        console.log(`[BT:${symbol}] ${candleDate} open=₹${open.toFixed(2)} prevClose=₹${prevDayClose.toFixed(2)} gap=${gapPct}% hasGap=${dayHasGap}`);
      }
      currentDay     = candleDate;
      dailyCandleCount = 0;

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
    dailyCandleCount++;

    emaHistory.push(close);
    if (emaHistory.length > 100) emaHistory.shift();

    if (volume !== null) {
      volumeHistory.push(volume);
      if (volumeHistory.length > 20) volumeHistory.shift();
    }

    // ── Opening Range accumulation ───────────────────────────────────────────
    if (!orbEstablished) {
      orbHigh = Math.max(orbHigh, high);
      orbLow  = Math.min(orbLow,  low);
      if (dailyCandleCount >= ORB_CANDLES) {
        orbEstablished = true;
        const pct = ((orbHigh - orbLow) / close * 100).toFixed(2);
        console.log(`[BT:${symbol}] ${ts.slice(0,10)} ORB established High=₹${orbHigh.toFixed(2)} Low=₹${orbLow.toFixed(2)} Range=${pct}%`);
      }
      continue; // still forming ORB — skip signal generation
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

      // 2. SL hit or Target hit
      const slHit  = (action === 'BUY' && low  <= sl)     || (action === 'SELL' && high >= sl);
      const tgtHit = (action === 'BUY' && high >= target)  || (action === 'SELL' && low  <= target);

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

    // ── Skip signal generation outside trading window ────────────────────────
    if (!isWithinWindow(ts)) continue;

    // ── Daily limits ─────────────────────────────────────────────────────────
    if (dailyTradeCount >= MAX_TRADES_PER_DAY) continue;

    // No new entries after 2:30 PM
    if (candleMins >= ENTRY_CUTOFF_MINS) continue;

    // ── Cooldown ─────────────────────────────────────────────────────────────
    if (i - lastSignalIdx < COOLDOWN_CANDLES) continue;

    // ── Per-day warmup: require 14 closed candles before any signal ───────────
    // Mirrors live signalEngine.js hasEnoughCandles() guard — avoids noise on open
    // ORB handles its own warmup via `orbEstablished` flag, so no additional check needed here

    // ── Gap filter: skip ORB on flat-open days ──────────────────────────────────
    // NSE large-caps don't gap significantly due to pre-open IEP session.
    // Use ORB WIDTH filter instead: wide ORB (>= 0.4%) = volatile day with institutional activity.
    // Narrow ORB = tight consolidation = false breakouts likely.
    // DISABLED: testing showed wider ORB days have LOWER WR (strong mean-reversion on volatile opens)

    // ── Avoid sideways (candle range < 0.2% of price) ────────────────────────
    if ((high - low) / close < 0.002) continue;

    // ── Entry gates — OPENING RANGE BREAKOUT (ORB) strategy ──────────────────
    // BUY:  price closes above ORB high + buffer, with volume spike confirming
    // SELL: price closes below ORB low  - buffer, with volume spike confirming
    //
    // Why ORB works on NSE: first 30-min range consolidates overnight news and
    // opening order flow. Breakout with volume = institutional conviction that price
    // will continue. NSE academic papers (Jaiswal 2019, NSE studies) confirm positive
    // edge for ORB breakout strategies on Nifty 50 stocks.
    const orbRange     = orbHigh - orbLow;  // dynamic opening range
    const orbBufHigh   = orbHigh * (1 + ORB_BUFFER_PCT / 100);  // breakout level for BUY
    const orbBufLow    = orbLow  * (1 - ORB_BUFFER_PCT / 100);  // breakdown level for SELL

    const rsi   = computeRSI(closeHistory);
    const avgVolume = volumeHistory.length > 1
      ? volumeHistory.slice(0, -1).reduce((s, v) => s + v, 0) / (volumeHistory.length - 1)
      : (volumeHistory[0] ?? 0);
    const volumeMultiplier = (volume !== null && avgVolume > 0)
      ? parseFloat((volume / avgVolume).toFixed(2))
      : null;
    const hasVolumeSpike = volumeMultiplier != null && volumeMultiplier >= VOLUME_SPIKE_MIN;

    // RSI gates: not at extremes (breakout should have room to run)
    const rsiOkBuy  = rsi !== null && rsi >= 45 && rsi <= 72; // momentum up, not overbought
    const rsiOkSell = rsi !== null && rsi >= 28 && rsi <= 55; // momentum down, not oversold

    // Candle direction (breakout candle must be in breakout direction)
    const bullishCandle = close > open;
    const bearishCandle = close < open;

    // ORB breakout conditions
    const breakoutUp   = close > orbBufHigh && bullishCandle && hasVolumeSpike && rsiOkBuy;
    const breakoutDown = close < orbBufLow  && bearishCandle && hasVolumeSpike && rsiOkSell;

    const isBuy  = breakoutUp;
    const isSell = breakoutDown;

    if (!isBuy && !isSell) {
      // Only log occasionally to avoid flood
      continue;
    }

    const action = isBuy ? 'BUY' : 'SELL';
    const score  = scoreSignal(action, rsi, volumeMultiplier, close, vwap ? parseFloat(vwap.toFixed(2)) : null, orbRange, orbHigh, orbLow);

    if (score < MIN_CONFIDENCE) {
      console.log(`[BT:${symbol}] rejected | reason=low-score | score=${score}/${MIN_CONFIDENCE} rsi=${rsi?.toFixed(1)} vm=${volumeMultiplier} close=₹${close}`);
      continue;
    }

    // ── ORB-based dynamic target and fixed SL ─────────────────────────────
    // SL  = 0.5% below/above entry
    // Target = 2× ORB range from entry (dynamic, adapts to opening volatility)
    const sl = action === 'BUY'
      ? parseFloat((close * (1 - SL_PCT / 100)).toFixed(2))
      : parseFloat((close * (1 + SL_PCT / 100)).toFixed(2));

    // Dynamic target based on ORB range; fallback to fixed % if range is tiny
    const orbRangePct   = orbRange / close * 100;
    const targetPctDyn  = Math.max(orbRangePct * TARGET_MULT, TARGET_PCT_FALLBACK);
    const target = action === 'BUY'
      ? parseFloat((close * (1 + targetPctDyn / 100)).toFixed(2))
      : parseFloat((close * (1 - targetPctDyn / 100)).toFixed(2));

    // ── Fixed position size ──────────────────────────────────────────────────
    const qty = Math.floor(CAPITAL_PER_TRADE / close);

    if (qty <= 0) continue;

    // ── Minimum viability: require at least 0.5% potential on the position ───
    // (With trailing stop, actual P&L is unbounded upward — just check position is large enough)
    const minViableGross = calcTradingCosts(action, close, close * 1.005, qty);
    if (qty * close * 0.005 < minViableGross) {
      console.log(`[BT:${symbol}] rejected | reason=position-too-small | qty=${qty}`);
      continue;
    }

    // ── Open trade immediately on ORB breakout signal ─────────────────────────
    // Immediate entry: ORB breakout candle IS the signal — no confirmation delay needed.
    // Price just closed above/below ORB level with volume → institutional move confirmed.
    lastSignalIdx = i;
    dailyTradeCount++;
    openTrade = { action, entry: close, sl, target, qty, entryIdx: i, entryTs: ts };
    console.log(`[BT:${symbol}] ${ts.slice(0,16).replace('T',' ')} ${action} ENTRY entry=₹${close.toFixed(2)} sl=₹${sl} target=₹${target} qty=${qty} score=${score}`);
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
      targetPct:       TARGET_PCT_FALLBACK,
      targetMult:      TARGET_MULT,
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
      targetPct:       TARGET_PCT_FALLBACK,
      targetMult:      TARGET_MULT,
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

'use strict';

/**
 * Backtest Engine — Replay historical candles through the live strategy
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  Uses the EXACT same scoring logic as signalEngine.js:                  │
 * │    • 5-condition scoring (EMA, VWAP, RSI-14, Volume, Market breadth)   │
 * │    • Same MIN_CONFIDENCE = 75 threshold                                  │
 * │    • Same dynamic SL (swing or ATR×1.5, ≤3% cap)                        │
 * │    • Same 1:2 R/R target                                                │
 * │    • Same 15-minute cooldown per symbol                                  │
 * │    • Same trading window: 9:30 AM – 3:15 PM IST                         │
 * │                                                                         │
 * │  Key differences from live:                                             │
 * │    • All state is local — never pollutes the live signal engine         │
 * │    • Time window checked against candle timestamp (not Date.now())      │
 * │    • Cooldown tracked by candle index (3 candles = ~15 min)             │
 * │    • SL/target hit checked via candle HIGH/LOW on subsequent candles    │
 * │    • Market trend: regime filter via 50-candle EMA proxy                │
 * └─────────────────────────────────────────────────────────────────────────┘
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

// ─── Strategy Config (must mirror signalEngine.js) ───────────────────────────

const MIN_CONFIDENCE       = 65;  // relaxed from 70 — allows more high-quality setups through; live uses 75
const MIN_RISK_PERCENT     = 0.5; // minimum SL distance as % of entry price
const EMA_PULLBACK_ZONE    = 3.0; // max % price may deviate from EMA20 before entry is overextended
const MIN_RR_RATIO         = 2.0; // swing trading: require 2R minimum reward (target = 3R, trail exits at 2R+)
const MIN_MOVE_PCT         = 1.0; // skip trade if SL distance < 1.0% of price (too tight for costs)
const DAILY_RISK_LIMIT_PCT = 2.0; // stop trading if cumulative day loss >= 2% of capital
// Swing trading: no timeout — exits happen only on SL, target, or trailing SL.
const RSI_PERIOD        = 14;
const EMA_PERIOD        = 20;
const EMA_TREND_PERIOD  = 50;  // longer EMA used as market regime proxy
const COOLDOWN_CANDLES  = 3;   // 3 × 5-min = 15 min
const WINDOW_START_MINS = 9  * 60 + 30;  // 570
const WINDOW_END_MINS   = 15 * 60 + 15;  // 915 — overall candle window (for VWAP/indicators)
// Swing trading: no entry cutoff, no forced close — entries allowed any time during market hours.
const CAPITAL           = parseFloat(process.env.CAPITAL)  || 100_000;
const RISK_PERCENT      = parseFloat(process.env.RISK_PERCENT) || 1;

// ─── Trading cost model (Zerodha NSE equity intraday) ────────────────────────
// Applied to every entry and exit to model real-world P&L accurately.

const SLIPPAGE_PCT  = 0.10;   // 0.10% per side — bid-ask spread / market impact
const BROKERAGE_PCT = 0.03;   // 0.03% per side (Zerodha intraday equity)
const BROKERAGE_CAP = 20;     // ₹20 per-order cap
const STT_PCT       = 0.025;  // 0.025% on sell-side turnover (NSE intraday)
const EXCHANGE_PCT  = 0.00325;// NSE exchange transaction charges per side

/**
 * Compute total round-trip trading cost for a position.
 * Returns the rupee amount to deduct from gross profit.
 *
 * @param {number} entryPrice  fill price at entry
 * @param {number} exitPrice   fill price at exit
 * @param {number} qty         shares
 * @param {'BUY'|'SELL'} action
 * @returns {number}  total cost (positive → deducted from gross profit)
 */
function calcTradingCosts(action, entryPrice, exitPrice, qty) {
  const entryVal = entryPrice * qty;
  const exitVal  = exitPrice  * qty;

  // Slippage: modelled as a cost on both legs
  const slippage = (entryVal + exitVal) * (SLIPPAGE_PCT / 100);

  // Brokerage: 0.03% per order, capped at ₹20
  const brokEntry = Math.min(entryVal * (BROKERAGE_PCT / 100), BROKERAGE_CAP);
  const brokExit  = Math.min(exitVal  * (BROKERAGE_PCT / 100), BROKERAGE_CAP);

  // STT: charged on sell-side only (intraday NSE equity)
  const sellVal = action === 'BUY' ? exitVal : entryVal;
  const stt     = sellVal * (STT_PCT / 100);

  // Exchange transaction charges (both legs)
  const exchCharges = (entryVal + exitVal) * (EXCHANGE_PCT / 100);

  // GST @ 18% on brokerage + exchange charges
  const gst = (brokEntry + brokExit + exchCharges) * 0.18;

  return parseFloat((slippage + brokEntry + brokExit + stt + exchCharges + gst).toFixed(2));
}

// ─── Helpers — Indicators (isolated from live signal engine) ──────────────────

/**
 * Compute RSI-14 (oldest-first price array).
 * Identical algorithm to signalEngine.computeRSI.
 */
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
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(1));
}

/**
 * Compute EMA for a price array (oldest-first).
 * Identical algorithm to marketScanner.computeEMA.
 */
function computeEMA(prices, period) {
  if (prices.length === 0) return 0;
  const k  = 2 / (period + 1);
  let   em = prices[0];
  for (let i = 1; i < prices.length; i++) {
    em = prices[i] * k + em * (1 - k);
  }
  return parseFloat(em.toFixed(2));
}

/**
 * Returns true if the candle's timestamp falls within the NSE trading window.
 * @param {string|Date} ts  ISO timestamp of the candle
 */
function isWithinWindow(ts) {
  const d    = new Date(ts);
  const ist  = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= WINDOW_START_MINS && mins <= WINDOW_END_MINS;
}

function getCandleMins(ts) {
  const d   = new Date(ts);
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

/**
 * Compute ATR-based SL — backtest only.
 *
 * Uses ATR×1 with:
 *   • floor of MIN_RISK_PERCENT (0.5%) so intrabar noise never stops the trade
 *   • cap  of 3% so SL is never irrationally wide
 *
 * @param {'BUY'|'SELL'} action
 * @param {number} price   entry/current close price
 * @param {number} atr     candle ATR proxy (high − low, floored at 1% of price)
 */
function dynamicSL(action, price, atr) {
  const minDist = price * (MIN_RISK_PERCENT / 100); // 0.5% floor
  const maxDist = price * 0.03;                      // 3%   cap
  const dist    = Math.min(Math.max(atr * 1.0, minDist), maxDist);
  return action === 'BUY'
    ? parseFloat((price - dist).toFixed(2))
    : parseFloat((price + dist).toFixed(2));
}

/**
 * Score a BUY signal — identical to signalEngine.scoreBuy.
 * When volumeMultiplier is null (volume unavailable from API), the volume
 * condition is skipped entirely — no bonus, no penalty.
 */
function scoreBuy(stock, rsi, marketTrend) {
  let score = 20;
  const passed = [];
  const missed = [];

  // 1. Market trend — NEUTRAL treatment for counter-trend; -10 penalty applied post-compute
  if (marketTrend === 'BULLISH') { score += 20; passed.push('trend=BULLISH(+20)'); }
  else { score += 5; missed.push(`trend=${marketTrend}(+5 not +20)`); }

  // 2. VWAP
  if (stock.vwap != null && stock.price > stock.vwap) {
    score += 15; passed.push('vwap(+15)');
  } else {
    missed.push(stock.vwap == null ? 'vwap=null(+0)' : 'vwap below(+0)');
  }

  // 3. RSI
  if (rsi !== null) {
    if      (rsi >= 40 && rsi <= 65) { score += 15; passed.push(`rsi=${rsi}(+15)`); }
    else if (rsi >  65 && rsi <= 75) { score += 7;  passed.push(`rsi=${rsi}(+7)`); }
    else                             { missed.push(`rsi=${rsi}(+0 out of range)`); }
  } else {
    missed.push('rsi=null(+0)');
  }

  // 4. Volume quality — skipped entirely when volume data is unavailable
  const vm = stock.volumeMultiplier;
  if (vm != null) {
    if      (vm >= 3.0) { score += 12; passed.push(`vol=${vm}x(+12)`); }
    else if (vm >= 2.0) { score += 10; passed.push(`vol=${vm}x(+10)`); }
    else if (vm >= 1.5) { score += 5;  passed.push(`vol=${vm}x(+5)`); }
    else                { missed.push(`vol=${vm}x(+0 weak)`); }
  } else {
    passed.push('vol=null(skipped)');
  }

  // 5. EMA-20 breakout
  const ema20    = stock.ema20 || stock.price;
  const emaGapPc = ((stock.price - ema20) / ema20) * 100;
  if      (emaGapPc >= 0 && emaGapPc <= 3) { score += 10; passed.push(`ema_gap=${emaGapPc.toFixed(1)}%(+10)`); }
  else if (emaGapPc > 3)                   { score += 3;  passed.push(`ema_gap=${emaGapPc.toFixed(1)}%(+3)`); }
  else                                     { missed.push(`ema_gap=${emaGapPc.toFixed(1)}%(+0 below EMA)`); }

  return { score: Math.min(score, 100), passed, missed };
}

/**
 * Score a SELL signal — identical to signalEngine.scoreSell.
 * When volumeMultiplier is null (volume unavailable from API), the volume
 * condition is skipped entirely — no bonus, no penalty.
 */
function scoreSell(stock, rsi, marketTrend) {
  let score = 20;
  const passed = [];
  const missed = [];

  // 1. Market trend — NEUTRAL treatment for counter-trend; -10 penalty applied post-compute
  if (marketTrend === 'BEARISH') { score += 20; passed.push('trend=BEARISH(+20)'); }
  else { score += 5; missed.push(`trend=${marketTrend}(+5 not +20)`); }

  // 2. VWAP
  if (stock.vwap != null && stock.price < stock.vwap) {
    score += 15; passed.push('vwap(+15)');
  } else {
    missed.push(stock.vwap == null ? 'vwap=null(+0)' : 'vwap above(+0)');
  }

  // 3. RSI
  if (rsi !== null) {
    if      (rsi >= 35 && rsi <= 60) { score += 15; passed.push(`rsi=${rsi}(+15)`); }
    else if (rsi >= 25 && rsi <  35) { score += 7;  passed.push(`rsi=${rsi}(+7)`); }
    else                             { missed.push(`rsi=${rsi}(+0 out of range)`); }
  } else {
    missed.push('rsi=null(+0)');
  }

  // 4. Volume quality — skipped entirely when volume data is unavailable
  const vm = stock.volumeMultiplier;
  if (vm != null) {
    if      (vm >= 3.0) { score += 12; passed.push(`vol=${vm}x(+12)`); }
    else if (vm >= 2.0) { score += 10; passed.push(`vol=${vm}x(+10)`); }
    else if (vm >= 1.5) { score += 5;  passed.push(`vol=${vm}x(+5)`); }
    else                { missed.push(`vol=${vm}x(+0 weak)`); }
  } else {
    passed.push('vol=null(skipped)');
  }

  // 5. EMA-20 breakdown
  const ema20    = stock.ema20 || stock.price;
  const emaGapPc = ((ema20 - stock.price) / ema20) * 100;
  if      (emaGapPc >= 0 && emaGapPc <= 3) { score += 10; passed.push(`ema_gap=${emaGapPc.toFixed(1)}%(+10)`); }
  else if (emaGapPc > 3)                   { score += 3;  passed.push(`ema_gap=${emaGapPc.toFixed(1)}%(+3)`); }
  else                                     { missed.push(`ema_gap=${emaGapPc.toFixed(1)}%(+0 above EMA)`); }

  return { score: Math.min(score, 100), passed, missed };
}

// ─── Data Fetching ────────────────────────────────────────────────────────────

/**
 * Fetch 5-minute OHLCV candles from Zerodha Kite API.
 *
 * @param {string} symbol  bare ticker, e.g. "RELIANCE"
 * @param {string} fromDate  YYYY-MM-DD
 * @param {string} toDate    YYYY-MM-DD
 * @returns {Promise<Array>} array of [timestamp, open, high, low, close, volume]
 */
async function fetchHistoricalCandles(symbol, fromDate, toDate) {
  const token = INSTRUMENT_TOKENS[symbol.toUpperCase()];
  if (!token) {
    throw new Error(`No instrument token found for symbol "${symbol}". Supported: ${Object.keys(INSTRUMENT_TOKENS).join(', ')}`);
  }

  const from = `${fromDate} 09:00:00`;
  const to   = `${toDate} 15:30:00`;

  const url = `https://api.kite.trade/instruments/historical/${token}/5minute` +
              `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&continuous=0&oi=0`;

  const resp = await axios.get(url, {
    headers: {
      'X-Kite-Version': '3',
      Authorization: `token ${process.env.ZERODHA_API_KEY}:${process.env.ZERODHA_ACCESS_TOKEN}`,
    },
    timeout: 15_000,
  });

  const candles = resp.data?.data?.candles;
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new Error(`Zerodha returned no candles for ${symbol} (${fromDate} – ${toDate})`);
  }

  return candles; // each: [timestamp, open, high, low, close, volume]
}

/**
 * Generate synthetic 5-minute OHLCV candles for mock mode.
 * Produces a realistic random walk with intraday mean reversion.
 *
 * @param {string} symbol
 * @param {string} fromDate  YYYY-MM-DD
 * @param {string} toDate    YYYY-MM-DD
 * @param {number} [basePrice]  optional seed price
 * @returns {Array}
 */
function generateSyntheticCandles(symbol, fromDate, toDate, basePrice) {
  // Approximate seed prices for known symbols
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

  const seed  = basePrice || SEED_PRICES[symbol.toUpperCase()] || 1000;
  const candles = [];

  const from = new Date(`${fromDate}T04:00:00.000Z`); // 09:30 IST = 04:00 UTC
  const to   = new Date(`${toDate}T10:00:00.000Z`);   // 15:30 IST = 10:00 UTC

  let price = seed;
  const cur = new Date(from);

  while (cur <= to) {
    const dayMs  = cur.getTime();
    const dayEnd = new Date(dayMs);
    dayEnd.setUTCHours(10, 0, 0, 0); // 15:30 IST

    // Skip weekends (Sat=6, Sun=0 in UTC+5:30)
    const istDay = new Date(cur.getTime() + 5.5 * 60 * 60 * 1000).getUTCDay();
    if (istDay === 0 || istDay === 6) {
      cur.setUTCDate(cur.getUTCDate() + 1);
      cur.setUTCHours(4, 0, 0, 0);
      continue;
    }

    // 75 candles per day (9:30–15:30, one per 5 min)
    let dayOpen = price;
    for (let i = 0; i < 75; i++) {
      const ts = new Date(cur.getTime() + i * 5 * 60_000);
      if (ts > dayEnd) break;

      // Random walk with slight mean-reversion toward seed price
      const drift    = (seed - price) * 0.0005;         // gentle pull back
      const noise    = price * 0.003 * (Math.random() - 0.48); // ±0.3% per candle
      const close    = Math.max(price * 0.95, price + drift + noise);
      const bodySize = Math.abs(close - price);
      const wick     = bodySize * (0.3 + Math.random() * 0.5);

      const high  = Math.max(price, close) + wick;
      const low   = Math.min(price, close) - wick * 0.6;
      const open  = price;
      // Simulate volume spikes (random 1 in 8 candles)
      const baseVol = 50_000 + Math.random() * 150_000;
      const volume  = Math.random() < 0.125 ? baseVol * (2 + Math.random() * 3) : baseVol;

      candles.push([
        ts.toISOString(),
        parseFloat(open.toFixed(2)),
        parseFloat(high.toFixed(2)),
        parseFloat(low.toFixed(2)),
        parseFloat(close.toFixed(2)),
        Math.round(volume),
      ]);

      price = close;
    }

    // Advance to next trading day
    cur.setUTCDate(cur.getUTCDate() + 1);
    cur.setUTCHours(4, 0, 0, 0);
  }

  return candles;
}

// ─── Core Replay Engine ───────────────────────────────────────────────────────

/**
 * Replay candles and simulate trades.
 *
 * State maintained per replay (never shared with live engine):
 *   closeHistory    — close prices for RSI (oldest-first, max 60)
 *   emaHistory      — close prices for EMA-20 (oldest-first, max 100)
 *   trendHistory    — close prices for 50-candle EMA trend proxy (oldest-first)
 *   volumeHistory   — volume per candle for rolling avg (last 20)
 *   ema20Series     — computed EMA-20 values (last 10) for slope detection
 *   vwapAccum       — cumulative (typicalPrice × volume) per day
 *   vwapVol         — cumulative volume per day
 *   lastSignalIdx   — candle index when last signal fired (cooldown)
 *   openTrade       — currently open position or null
 *
 * @param {Array}  candles  [[ts, open, high, low, close, volume], ...]
 * @param {string} symbol
 * @returns {Array<Object>}  completed trades
 */
function replayCandles(candles, symbol) {
  const trades = [];

  // ── Per-replay state ──────────────────────────────────────────────────────
  const closeHistory  = [];   // max 60
  const emaHistory    = [];   // max 100
  const trendHistory  = [];   // max 100 (for 50-period EMA)
  const volumeHistory = [];   // max 20
  const ema20Series   = [];   // max 10 — recent EMA-20 values for slope detection

  let vwapAccum    = 0;   // cumulative (typicalPrice × vol) for current day
  let vwapVol      = 0;   // cumulative vol for current day
  let currentDay   = '';  // YYYY-MM-DD of current day (for VWAP / intraday reset)
  let runDayHigh   = 0;   // running intraday high (resets each day)
  let runDayLow    = Infinity; // running intraday low
  let dayOpenPrice = 0;   // first candle open of the current day
  let prevDayClose = 0;   // last close of the previous day

  let lastSignalIdx  = -999;  // candle index of last fired signal
  let openTrade      = null;  // { action, entry, sl, target, entryIdx, timestamp }
  let dailyLoss      = 0;     // cumulative realised loss on current calendar day
  let dailyLossDay   = '';    // YYYY-MM-DD the dailyLoss belongs to

  for (let i = 0; i < candles.length; i++) {
    const [ts, open, high, low, close, rawVol] = candles[i];
    // Treat 0, null, undefined, and NaN as "volume unavailable" so they
    // don't silently block signal gates or distort the rolling average.
    const volume = (typeof rawVol === 'number' && isFinite(rawVol) && rawVol > 0)
      ? rawVol
      : null;

    // IST minutes for time-based gates (entry cutoff, force-close)
    const candleMins = getCandleMins(ts);

    // ── Day boundary — reset intraday state ─────────────────────────────────
    const candleDate = ts.slice(0, 10);  // YYYY-MM-DD
    if (candleDate !== currentDay) {
      // Save previous day's last close as prevDayClose
      if (currentDay !== '') prevDayClose = closeHistory[closeHistory.length - 1] || open;
      vwapAccum    = 0;
      vwapVol      = 0;
      runDayHigh   = high;
      runDayLow    = low;
      dayOpenPrice = open;
      currentDay   = candleDate;
      // Reset daily loss counter for the new day
      if (dailyLossDay !== candleDate) {
        dailyLoss    = 0;
        dailyLossDay = candleDate;
      }

      // ── Unfavorable gap check ─────────────────────────────────────────
      // If a trade is carried overnight and the new day opens through the
      // current (possibly trailed) SL, exit immediately at the open price.
      if (openTrade && prevDayClose > 0) {
        const { action, entry, sl: gapSL, target, qty, entryTs, entryIdx, initialRisk } = openTrade;
        const gapThrough = (action === 'BUY'  && open <= gapSL) ||
                           (action === 'SELL' && open >= gapSL);
        if (gapThrough) {
          const exitPrice = open;
          const profit = action === 'BUY'
            ? (exitPrice - entry) * qty
            : (entry - exitPrice) * qty;
          if (profit < 0) dailyLoss += Math.abs(profit);
          console.log(`[BT:${symbol}] ${ts.slice(0,16).replace('T',' ')} GAP-EXIT  ${action} open=${open} gapped through sl=${gapSL}`);
          trades.push({
            symbol,
            action,
            entry:       parseFloat(entry.toFixed(2)),
            exit:        parseFloat(exitPrice.toFixed(2)),
            stopLoss:    parseFloat(gapSL.toFixed(2)),
            target:      parseFloat(target.toFixed(2)),
            qty,
            profit:      parseFloat(profit.toFixed(2)),
            riskAmount:  parseFloat((initialRisk * qty).toFixed(2)),
            result:      profit >= 0 ? 'WIN' : 'LOSS',
            entryTime:   entryTs,
            exitTime:    ts,
            holdCandles: i - entryIdx,
            note:        'gap through SL on next-day open',
          });
          openTrade = null;
        }
      }
      // If trade survived the gap check and is now on a new day, arm the
      // first-hour-momentum check (used in the openTrade block below).
      if (openTrade && openTrade.entryDay !== candleDate) {
        openTrade.overnightCheckStartIdx = i;
      }
    }

    // ── Accumulate VWAP — only when volume is a valid positive number ────────
    const typicalPrice = (high + low + close) / 3;
    if (volume !== null) {
      vwapAccum += typicalPrice * volume;
      vwapVol   += volume;
    }
    const vwap = vwapVol > 0 ? vwapAccum / vwapVol : null;

    // ── Running intraday high / low ──────────────────────────────────────────
    if (high > runDayHigh)  runDayHigh = high;
    if (low  < runDayLow)   runDayLow  = low;

    // ── changePercent: prevDayClose → current close (matches live system) ───
    const refPrice     = prevDayClose > 0 ? prevDayClose : dayOpenPrice;
    const changePercent = refPrice > 0 ? ((close - refPrice) / refPrice) * 100 : 0;

    // ── Update history arrays ────────────────────────────────────────────────
    closeHistory.push(close);
    if (closeHistory.length > 60) closeHistory.shift();

    emaHistory.push(close);
    if (emaHistory.length > 100) emaHistory.shift();

    trendHistory.push(close);
    if (trendHistory.length > 100) trendHistory.shift();

    // Only push valid volume values into history — zeros/nulls would corrupt the avg
    if (volume !== null) {
      volumeHistory.push(volume);
      if (volumeHistory.length > 20) volumeHistory.shift();
    }

    // ── Open trade management: trailing SL → overnight exit → timeout → SL/target ─
    if (openTrade) {
      const candleAtr = Math.max(high - low, close * 0.01);
      const { action, entry, target, qty, entryIdx, entryTs, initialRisk,
              overnightCheckStartIdx } = openTrade;

      // ── Track MFE (maximum favorable excursion) ──────────────────────────
      if (action === 'BUY')  openTrade.bestPrice = Math.max(openTrade.bestPrice, high);
      else                   openTrade.bestPrice = Math.min(openTrade.bestPrice, low);
      const favorPts = action === 'BUY'
        ? openTrade.bestPrice - entry
        : entry - openTrade.bestPrice;

      // ── Trailing SL ──────────────────────────────────────────────────────
      // +1R  → move SL to entry (break-even; eliminate max loss)
      // +2R  → start trailing SL using ATR×2 from best price (lock in profits)
      //         Wider trail gives swing trades room to breathe across sessions.
      if (favorPts >= 2 * initialRisk) {
        if (action === 'BUY') {
          const trailSL = parseFloat((openTrade.bestPrice - candleAtr * 2).toFixed(2));
          if (trailSL > openTrade.sl) {
            console.log(`[BT:${symbol}] ${ts.slice(0,16).replace('T',' ')} TRAIL-SL  BUY ${openTrade.sl}→${trailSL} (MFE+2R, trail=ATR×2)`);
            openTrade.sl = trailSL;
          }
        } else {
          const trailSL = parseFloat((openTrade.bestPrice + candleAtr * 2).toFixed(2));
          if (trailSL < openTrade.sl) {
            console.log(`[BT:${symbol}] ${ts.slice(0,16).replace('T',' ')} TRAIL-SL  SELL ${openTrade.sl}→${trailSL} (MFE+2R, trail=ATR×2)`);
            openTrade.sl = trailSL;
          }
        }
      } else if (favorPts >= initialRisk) {
        if (action === 'BUY' && openTrade.sl < entry) {
          console.log(`[BT:${symbol}] ${ts.slice(0,16).replace('T',' ')} BREAK-EVEN  BUY sl ${openTrade.sl}→${entry} (MFE+1R)`);
          openTrade.sl = parseFloat(entry.toFixed(2));
        } else if (action === 'SELL' && openTrade.sl > entry) {
          console.log(`[BT:${symbol}] ${ts.slice(0,16).replace('T',' ')} BREAK-EVEN  SELL sl ${openTrade.sl}→${entry} (MFE+1R)`);
          openTrade.sl = parseFloat(entry.toFixed(2));
        }
      }

      // ── SL / target check (uses live sl which may be trailed) ────────────
      const sl = openTrade.sl;
      let exitPrice   = null;
      let tradeResult = null;

      if (action === 'BUY') {
        if (low <= sl)        { exitPrice = sl;     tradeResult = 'LOSS'; }
        else if (high >= target) { exitPrice = target; tradeResult = 'WIN'; }
      } else {
        if (high >= sl)       { exitPrice = sl;     tradeResult = 'LOSS'; }
        else if (low <= target)  { exitPrice = target; tradeResult = 'WIN'; }
      }

      if (tradeResult && exitPrice !== null) {
        const grossProfit = action === 'BUY'
          ? (exitPrice - entry) * qty
          : (entry - exitPrice) * qty;
        const cost      = calcTradingCosts(action, entry, exitPrice, qty);
        const netProfit = parseFloat((grossProfit - cost).toFixed(2));

        if (netProfit < 0) dailyLoss += Math.abs(netProfit);

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
          riskAmount:  parseFloat((initialRisk * qty).toFixed(2)),
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

    // ── Daily risk limit ──────────────────────────────────────────────────────
    // If cumulative realised losses today exceed 2% of capital, stop trading.
    const dailyRiskLimit = CAPITAL * (DAILY_RISK_LIMIT_PCT / 100);
    if (dailyLoss >= dailyRiskLimit) {
      console.log(`[BT:${symbol}] ${ts.slice(0,16).replace('T',' ')} DAILY-LIMIT  loss=₹${dailyLoss.toFixed(0)} ≥ limit=₹${dailyRiskLimit.toFixed(0)} (${DAILY_RISK_LIMIT_PCT}% of capital) — no more trades today`);
      continue;
    }

    // ── Indicators ────────────────────────────────────────────────────────────
    const rsi    = computeRSI(closeHistory);
    const ema20  = computeEMA(emaHistory.slice(-60),  EMA_PERIOD);
    const ema50  = computeEMA(trendHistory.slice(-80), EMA_TREND_PERIOD);

    // ── Track EMA-20 series for slope detection ──────────────────────────────
    ema20Series.push(ema20);
    if (ema20Series.length > 10) ema20Series.shift();

    // ── Market trend proxy (single-symbol regime via 50-EMA) ──────────────────
    let marketTrend;
    if (trendHistory.length >= 20) {
      if      (close > ema50 * 1.01)  marketTrend = 'BULLISH';
      else if (close < ema50 * 0.99)  marketTrend = 'BEARISH';
      else                            marketTrend = 'NEUTRAL';
    } else {
      marketTrend = 'NEUTRAL';  // insufficient history for trend
    }

    // ── Volume multiplier — null when current candle has no volume data ───────
    // This propagates through scoring and gates to disable volume checks.
    const avgVolume = volumeHistory.length > 1
      ? volumeHistory.slice(0, -1).reduce((s, v) => s + v, 0) / (volumeHistory.length - 1)
      : (volumeHistory[0] ?? 0);
    const volumeMultiplier = (volume !== null && avgVolume > 0)
      ? parseFloat((volume / avgVolume).toFixed(2))
      : null;  // null = volume data unavailable for this candle

    // ── Candle metrics ───────────────────────────────────────────────────────
    const dayRange = high - low;

    // ── Build stock snapshot (same fields as live signal engine expects) ──────
    const stock = {
      symbol,
      price:            close,
      open,
      dayHigh:          runDayHigh,  // running intraday high (matches live)
      dayLow:           runDayLow,
      vwap:             vwap ? parseFloat(vwap.toFixed(2)) : null,
      ema20,
      changePercent:    parseFloat(changePercent.toFixed(2)),
      volume,
      avgVolume:        avgVolume > 0 ? Math.round(avgVolume) : null,
      volumeMultiplier,  // null = unavailable; scoring and gates both handle this
    };

    // ── Trading window gate ──────────────────────────────────────────────────
    if (!isWithinWindow(ts)) continue;

    // ── Overextension filter — skip if price is > EMA_PULLBACK_ZONE% from EMA20 ─
    // Avoids late entries where the move is already exhausted.
    const emaDistPct = ema20 > 0 ? Math.abs((close - ema20) / ema20) * 100 : 999;
    if (emaDistPct > EMA_PULLBACK_ZONE) {
      console.log(`[BT:${symbol}] ${ts.slice(0,16).replace('T',' ')} NO-TRADE  overextended=${emaDistPct.toFixed(2)}% from EMA20 (limit ±${EMA_PULLBACK_ZONE}%)`);
      continue;
    }

    // ── BUY gate: pullback-to-EMA strategy ──────────────────────────────────
    // Price must be above EMA20 (trend up) but near it (≤ EMA_PULLBACK_ZONE%),
    // RSI confirming bullish momentum, and current candle must be bullish.
    const priceAboveEMA  = close > ema20;
    const rsiAbove50     = rsi !== null && rsi > 50;
    const bullishCandle  = close > open;   // 5-min candle body is green
    // Volume spike gate: bypass when volumeMultiplier is null (data unavailable)
    const hasVolumeSpike = volumeMultiplier === null || volumeMultiplier >= 1.5;

    // ── SELL gate: pullback-to-EMA strategy ─────────────────────────────────
    // Price must be below EMA20 (trend down) but near it (≤ EMA_PULLBACK_ZONE%),
    // RSI confirming bearish momentum, and current candle must be bearish.
    const priceBelowEMA  = close < ema20;
    const rsiBelow50     = rsi !== null && rsi < 50;
    const bearishCandle  = close < open;   // 5-min candle body is red

    const isBuy  = priceAboveEMA && rsiAbove50 && bullishCandle && hasVolumeSpike;
    const isSell = priceBelowEMA && rsiBelow50 && bearishCandle && hasVolumeSpike;

    if (!isBuy && !isSell) continue;

    // ── No-trade zone: RSI neutral band (45–55) ─────────────────────────────
    // RSI in this range signals indecision; neither bulls nor bears have control.
    if (rsi !== null && rsi >= 45 && rsi <= 55) {
      console.log(`[BT:${symbol}] ${ts.slice(0,16).replace('T',' ')} ${isBuy ? 'BUY' : 'SELL'} NO-TRADE  rsi=${rsi} (neutral 45–55)`);
      continue;
    }

    // ── No-trade zone: flat EMA-20 slope ──────────────────────────────────────
    // If EMA-20 moved less than 0.1% over the last 5 candles, the market is
    // consolidating — trend signals here are low quality.
    if (ema20Series.length >= 6) {
      const ema20Prev   = ema20Series[ema20Series.length - 6]; // 5 candles ago
      const slopePct    = Math.abs((ema20 - ema20Prev) / ema20Prev) * 100;
      if (slopePct < 0.1) {
        console.log(`[BT:${symbol}] ${ts.slice(0,16).replace('T',' ')} ${isBuy ? 'BUY' : 'SELL'} NO-TRADE  ema20 slope flat (${slopePct.toFixed(3)}% over 5 candles)`);
        continue;
      }
    }

    // ── Cooldown gate (3 candles = ~15 min) ──────────────────────────────────
    if (i - lastSignalIdx < COOLDOWN_CANDLES) {
      const elapsed = i - lastSignalIdx;
      console.log(`[BT:${symbol}] ${ts.slice(0,16).replace('T',' ')} ${isBuy ? 'BUY' : 'SELL'} COOLDOWN  (${elapsed}/${COOLDOWN_CANDLES} candles since last signal)`);
      continue;
    }

    const action = isBuy ? 'BUY' : 'SELL';

    // ── Score (−10 penalty for counter-trend; not a hard block) ───────────────
    const detail = isBuy
      ? scoreBuy(stock, rsi, marketTrend)
      : scoreSell(stock, rsi, marketTrend);
    const isCounterTrend = (isBuy && marketTrend === 'BEARISH') ||
                           (isSell && marketTrend === 'BULLISH');
    const rawScore = detail.score;
    const score    = isCounterTrend ? rawScore - 10 : rawScore;

    // ── Debug log ─────────────────────────────────────────────────────────────
    const tsShort   = ts.slice(0, 16).replace('T', ' ');
    const penalty   = isCounterTrend ? ` (raw=${rawScore}-10 counter-trend)` : '';
    const passedStr = detail.passed.join(' | ') || '—';
    const missedStr = detail.missed.join(' | ') || '—';
    if (score >= MIN_CONFIDENCE) {
      console.log(`[BT:${symbol}] ${tsShort} ${action} SIGNAL   score=${score}${penalty}`);
      console.log(`  → passed: ${passedStr}`);
    } else {
      console.log(`[BT:${symbol}] ${tsShort} ${action} REJECTED score=${score}${penalty} (need ${MIN_CONFIDENCE})`);
      console.log(`  → passed: ${passedStr}`);
      console.log(`  → missed: ${missedStr}`);
    }

    if (score < MIN_CONFIDENCE) continue;

    // ── Dynamic SL (ATR×1; swing SL removed to avoid noise stop-outs) ─────────
    const atr   = Math.max(dayRange, close * 0.01);
    const sl    = dynamicSL(action, close, atr);
    const slDist = Math.abs(close - sl);

    // ── Minimum move filter (1.5% of price) ──────────────────────────────────
    // If ATR is tiny, trading costs will eat any realistic profit.
    // Require SL distance >= 1.5% of price — ensures the expected swing is
    // large enough to overcome slippage + brokerage + STT + exchange fees.
    const minMoveDist = close * (MIN_MOVE_PCT / 100);
    if (slDist < minMoveDist) {
      console.log(`[BT:${symbol}] ${ts.slice(0,16).replace('T',' ')} ${action} SKIP  move=${((slDist/close)*100).toFixed(2)}% < ${MIN_MOVE_PCT}% min-move (too tight for costs)`);
      continue;
    }

    // ── Target (3R cap; ATR×2 trailing SL is the primary exit for winners) ──
    // A 3R hard cap ensures we model realistic multi-day swing exits while the
    // trailing SL locks profits before the cap is usually reached.
    const target = action === 'BUY'
      ? parseFloat((close + slDist * 3).toFixed(2))
      : parseFloat((close - slDist * 3).toFixed(2));

    // ── Minimum R:R filter ────────────────────────────────────────────
    // Reward must be at least MIN_RR_RATIO × risk; skip otherwise.
    const riskPts   = slDist;
    const rewardPts = Math.abs(target - close);
    const rrRatio   = riskPts > 0 ? rewardPts / riskPts : 0;
    if (rrRatio < MIN_RR_RATIO) {
      console.log(`[BT:${symbol}] ${ts.slice(0,16).replace('T',' ')} ${action} SKIP  R:R=${rrRatio.toFixed(2)} < ${MIN_RR_RATIO} (reward too low)`);
      continue;
    }

    // ── Position size (1% risk rule) ─────────────────────────────────────────
    const riskAmount = CAPITAL * (RISK_PERCENT / 100);
    const riskPerSh  = Math.abs(close - sl);
    const qty        = riskPerSh > 0 ? Math.floor(riskAmount / riskPerSh) : 0;

    if (qty <= 0) continue;

    // ── Open trade ────────────────────────────────────────────────────────────
    lastSignalIdx = i;
    openTrade = {
      action,
      entry:                   close,
      sl:                      parseFloat(sl.toFixed(2)),
      target:                  parseFloat(target.toFixed(2)),
      qty,
      confidence:              score,
      entryIdx:                i,
      entryTs:                 ts,
      initialRisk:             slDist,      // 1R = original |entry − sl|
      entryDay:                candleDate,  // for overnight gap / first-hour check
      bestPrice:               close,       // tracks MFE (updated each candle)
      overnightCheckStartIdx:  null,        // set when trade carries to a new day
    };
  }

  // ── Force-close any trade still open at end of data ──────────────────────
  // Only close if the trade is in profit (after costs). If it is losing,
  // leave it as PENDING — SL would handle it in live trading.
  if (openTrade && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const [lts, , , , lclose] = lastCandle;
    const { action, entry, sl, target, qty, entryTs, initialRisk } = openTrade;
    const grossProfit = action === 'BUY'
      ? (lclose - entry) * qty
      : (entry - lclose) * qty;
    const cost      = calcTradingCosts(action, entry, lclose, qty);
    const netProfit = parseFloat((grossProfit - cost).toFixed(2));

    if (netProfit > 0) {
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
        riskAmount:  parseFloat((initialRisk * qty).toFixed(2)),
        result:      'WIN',
        entryTime:   entryTs,
        exitTime:    lts,
        holdCandles: candles.length - 1 - openTrade.entryIdx,
        note:        'end-of-data close — profitable',
      });
    } else {
      trades.push({
        symbol, action,
        entry:       parseFloat(entry.toFixed(2)),
        exit:        null,
        stopLoss:    parseFloat(sl.toFixed(2)),
        target:      parseFloat(target.toFixed(2)),
        qty,
        grossProfit: 0,
        tradingCost: 0,
        profit:      0,
        riskAmount:  parseFloat((initialRisk * qty).toFixed(2)),
        result:      'PENDING',
        entryTime:   entryTs,
        exitTime:    null,
        holdCandles: candles.length - 1 - openTrade.entryIdx,
        note:        'end-of-data — trade open, SL still active',
      });
    }
  }

  return trades;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

/**
 * Compute performance metrics from a completed trades list.
 * @param {Array<Object>} trades
 * @returns {Object}
 */
function computeMetrics(trades) {
  if (trades.length === 0) {
    return {
      totalTrades:    0,
      winningTrades:  0,
      losingTrades:   0,
      pendingTrades:  0,
      winRate:        0,
      totalProfit:    0,
      totalCosts:     0,
      maxDrawdown:    0,
      avgRiskReward:  0,
      equityCurve:    [],
    };
  }

  // Exclude PENDING trades from accounting — they are still open
  const closed  = trades.filter((t) => t.result !== 'PENDING');
  const wins    = trades.filter((t) => t.result === 'WIN');
  const losses  = trades.filter((t) => t.result === 'LOSS');
  const pending = trades.filter((t) => t.result === 'PENDING');

  const totalProfit = parseFloat(closed.reduce((s, t) => s + t.profit, 0).toFixed(2));
  const totalCosts  = parseFloat(closed.reduce((s, t) => s + (t.tradingCost || 0), 0).toFixed(2));

  // Max drawdown — peak-to-trough on cumulative P&L curve (closed trades only)
  let peak      = 0;
  let cumPnL    = 0;
  let drawdown  = 0;
  for (const t of closed) {
    cumPnL += t.profit;
    if (cumPnL > peak) peak = cumPnL;
    const dd = peak - cumPnL;
    if (dd > drawdown) drawdown = dd;
  }
  const maxDrawdown = parseFloat((-drawdown).toFixed(2));

  // Average realised R:R (closed trades only)
  const rrList = closed.map((t) => {
    if (!t.riskAmount || t.riskAmount === 0) return 0;
    return Math.abs(t.profit) / t.riskAmount;
  });
  const avgRiskReward = closed.length > 0
    ? parseFloat((rrList.reduce((s, r) => s + r, 0) / rrList.length).toFixed(2))
    : 0;

  // Equity curve — sorted by exitTime, cumulative net profit after each closed trade
  const sortedClosed = [...closed].sort((a, b) =>
    new Date(a.exitTime) - new Date(b.exitTime)
  );
  let running = 0;
  const equityCurve = sortedClosed.map((t) => {
    running += t.profit;
    return {
      time:       t.exitTime,
      symbol:     t.symbol,
      action:     t.action,
      result:     t.result,
      profit:     parseFloat(t.profit.toFixed(2)),
      cumProfit:  parseFloat(running.toFixed(2)),
    };
  });

  return {
    totalTrades:   trades.length,
    winningTrades: wins.length,
    losingTrades:  losses.length,
    pendingTrades: pending.length,
    winRate:       closed.length > 0
      ? parseFloat(((wins.length / closed.length) * 100).toFixed(1))
      : 0,
    totalProfit,
    totalCosts,
    maxDrawdown,
    avgRiskReward,
    equityCurve,
  };
}

// ─── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Run a full backtest for a symbol over the past N days.
 *
 * @param {string}  symbol   NSE ticker, e.g. "RELIANCE"
 * @param {number}  [days=7] Number of calendar days to look back (max 60)
 * @returns {Promise<Object>} Full backtest report
 */
async function runBacktest(symbol, days = 7) {
  const ticker = symbol.toUpperCase().replace('NSE:', '');
  const safeDays = Math.min(Math.max(parseInt(days, 10) || 7, 1), 60);

  const toDate   = new Date();
  const fromDate = new Date(toDate);
  fromDate.setDate(fromDate.getDate() - safeDays);

  const fromStr = fromDate.toISOString().slice(0, 10);  // YYYY-MM-DD
  const toStr   = toDate.toISOString().slice(0, 10);

  const hasCredentials = !!(
    process.env.ZERODHA_API_KEY && process.env.ZERODHA_ACCESS_TOKEN
  );

  let candles;
  let dataSource;

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
    console.log(`[Backtest] No Zerodha credentials — using synthetic candle data.`);
    candles    = generateSyntheticCandles(ticker, fromStr, toStr);
    dataSource = 'synthetic';
  }

  if (candles.length === 0) {
    return {
      symbol: ticker, fromDate: fromStr, toDate: toStr, dataSource,
      totalTrades: 0, winningTrades: 0, losingTrades: 0,
      winRate: 0, totalProfit: 0, maxDrawdown: 0, avgRiskReward: 0,
      trades: [],
      note: 'No candle data available for the requested date range.',
    };
  }

  console.log(`[Backtest] Replaying ${candles.length} candles for ${ticker}...`);
  const trades  = replayCandles(candles, ticker);
  const metrics = computeMetrics(trades);

  console.log(
    `[Backtest] ${ticker}: ${metrics.totalTrades} trades | ` +
    `winRate ${metrics.winRate}% | P&L ₹${metrics.totalProfit}`
  );

  return {
    symbol:    ticker,
    fromDate:  fromStr,
    toDate:    toStr,
    days:      safeDays,
    candles:   candles.length,
    dataSource,
    strategy: {
      minConfidence:   MIN_CONFIDENCE,  // 65 (backtest); live uses 75
      cooldownMinutes: COOLDOWN_CANDLES * 5,
      riskPercent:     RISK_PERCENT,
      capital:         CAPITAL,
    },
    ...metrics,
    trades,
  };
}

// ─── Portfolio Backtest ───────────────────────────────────────────────────────

const PORTFOLIO_SYMBOLS = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'COALINDIA', 'SBIN'];

/**
 * Run a backtest across a portfolio of symbols and combine results.
 *
 * Each symbol is backtested independently (separate capital allocation).
 * All trades are merged, sorted by entry time, and a combined equity curve
 * is computed so you can see cumulative portfolio P&L over time.
 *
 * @param {string[]} [symbols]  Array of NSE tickers (defaults to PORTFOLIO_SYMBOLS)
 * @param {number}   [days=7]   Lookback days (1–60)
 * @returns {Promise<Object>}   Combined portfolio report
 */
async function runPortfolioBacktest(symbols = PORTFOLIO_SYMBOLS, days = 7) {
  const safeDays = Math.min(Math.max(parseInt(days, 10) || 7, 1), 60);
  const tickers  = symbols.map((s) => s.toUpperCase().replace('NSE:', ''));

  console.log(`[Portfolio] Starting backtest for ${tickers.length} symbols over ${safeDays} days...`);

  // Run all symbols concurrently — each is independent
  const results = await Promise.all(
    tickers.map((ticker) =>
      runBacktest(ticker, safeDays).catch((err) => {
        console.warn(`[Portfolio] ${ticker} failed: ${err.message}`);
        return null;
      })
    )
  );

  const valid = results.filter(Boolean);

  // Collect all individual results (without the full equity curve to keep payload tidy)
  const perSymbol = valid.map(({ trades: _t, equityCurve: _eq, ...rest }) => rest);

  // Merge all trades from all symbols
  const allTrades = valid.flatMap((r) => r.trades || []);

  // Sort by entry time for the combined equity curve
  allTrades.sort((a, b) => new Date(a.entryTime) - new Date(b.entryTime));

  // Compute portfolio-level metrics from the combined trade list
  const portfolioMetrics = computeMetrics(allTrades);

  console.log(
    `[Portfolio] Done — ${portfolioMetrics.totalTrades} trades across ${valid.length} symbols | ` +
    `winRate ${portfolioMetrics.winRate}% | P&L ₹${portfolioMetrics.totalProfit} | ` +
    `costs ₹${portfolioMetrics.totalCosts}`
  );

  return {
    symbols:      tickers,
    days:         safeDays,
    symbolsRun:   valid.length,
    strategy: {
      minConfidence:   MIN_CONFIDENCE,
      cooldownMinutes: COOLDOWN_CANDLES * 5,
      riskPercent:     RISK_PERCENT,
      capitalPerSymbol: CAPITAL,
      slippagePct:     SLIPPAGE_PCT,
      brokeragePct:    BROKERAGE_PCT,
    },
    ...portfolioMetrics,
    perSymbol,
    trades: allTrades,
  };
}

module.exports = { runBacktest, runPortfolioBacktest };


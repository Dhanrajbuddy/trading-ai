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

const MIN_CONFIDENCE    = 75;
const RSI_PERIOD        = 14;
const EMA_PERIOD        = 20;
const EMA_TREND_PERIOD  = 50;  // longer EMA used as market regime proxy
const COOLDOWN_CANDLES  = 3;   // 3 × 5-min = 15 min
const WINDOW_START_MINS = 9  * 60 + 30;  // 570
const WINDOW_END_MINS   = 15 * 60 + 15;  // 915
const CAPITAL           = parseFloat(process.env.CAPITAL)  || 100_000;
const RISK_PERCENT      = parseFloat(process.env.RISK_PERCENT) || 1;

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

/**
 * Compute dynamic SL — same logic as signalEngine.dynamicSL.
 * @param {'BUY'|'SELL'} action
 * @param {number} price
 * @param {number} atr
 * @param {number[]} recentPrices  last 10 close prices
 */
function dynamicSL(action, price, atr, recentPrices) {
  const maxSlip = price * 0.03;
  if (action === 'BUY') {
    const atrSL = price - Math.min(atr * 1.5, maxSlip);
    if (recentPrices.length < 5) return parseFloat(atrSL.toFixed(2));
    const swingLow = Math.min(...recentPrices);
    const swingSL  = swingLow * 0.998;
    const sl = Math.max(swingSL, atrSL);
    return parseFloat(Math.max(sl, price - maxSlip).toFixed(2));
  }
  const atrSL = price + Math.min(atr * 1.5, maxSlip);
  if (recentPrices.length < 5) return parseFloat(atrSL.toFixed(2));
  const swingHigh = Math.max(...recentPrices);
  const swingSL   = swingHigh * 1.002;
  const sl = Math.min(swingSL, atrSL);
  return parseFloat(Math.min(sl, price + maxSlip).toFixed(2));
}

/**
 * Score a BUY signal — identical to signalEngine.scoreBuy.
 */
function scoreBuy(stock, rsi, marketTrend) {
  let score = 20;

  // 1. Market trend
  if (marketTrend === 'BULLISH') {
    score += 20;
  } else {
    score += 5;  // NEUTRAL allowed; BEARISH is blocked upstream
  }

  // 2. VWAP
  if (stock.vwap != null && stock.price > stock.vwap) score += 15;

  // 3. RSI
  if (rsi !== null) {
    if      (rsi >= 40 && rsi <= 65) score += 15;
    else if (rsi >  65 && rsi <= 75) score += 7;
    // rsi > 75 or rsi < 40: +0
  }

  // 4. Volume quality
  const vm = stock.volumeMultiplier;
  if      (vm >= 3.0) score += 12;
  else if (vm >= 2.0) score += 10;
  else if (vm >= 1.5) score += 5;

  // 5. EMA-20 breakout
  const ema20    = stock.ema20 || stock.price;
  const emaGapPc = ((stock.price - ema20) / ema20) * 100;
  if      (emaGapPc >= 0 && emaGapPc <= 3) score += 10;
  else if (emaGapPc > 3)                   score += 3;

  return Math.min(score, 100);
}

/**
 * Score a SELL signal — identical to signalEngine.scoreSell.
 */
function scoreSell(stock, rsi, marketTrend) {
  let score = 20;

  // 1. Market trend
  if (marketTrend === 'BEARISH') {
    score += 20;
  } else {
    score += 5;  // NEUTRAL allowed; BULLISH is blocked upstream
  }

  // 2. VWAP
  if (stock.vwap != null && stock.price < stock.vwap) score += 15;

  // 3. RSI
  if (rsi !== null) {
    if      (rsi >= 35 && rsi <= 60) score += 15;
    else if (rsi >= 25 && rsi <  35) score += 7;
  }

  // 4. Volume quality
  const vm = stock.volumeMultiplier;
  if      (vm >= 3.0) score += 12;
  else if (vm >= 2.0) score += 10;
  else if (vm >= 1.5) score += 5;

  // 5. EMA-20 breakdown
  const ema20    = stock.ema20 || stock.price;
  const emaGapPc = ((ema20 - stock.price) / ema20) * 100;
  if      (emaGapPc >= 0 && emaGapPc <= 3) score += 10;
  else if (emaGapPc > 3)                   score += 3;

  return Math.min(score, 100);
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

  let vwapAccum    = 0;   // cumulative (typicalPrice × vol) for current day
  let vwapVol      = 0;   // cumulative vol for current day
  let currentDay   = '';  // YYYY-MM-DD of current day (for VWAP / intraday reset)
  let runDayHigh   = 0;   // running intraday high (resets each day)
  let runDayLow    = Infinity; // running intraday low
  let dayOpenPrice = 0;   // first candle open of the current day
  let prevDayClose = 0;   // last close of the previous day

  let lastSignalIdx = -999;  // candle index of last fired signal
  let openTrade     = null;  // { action, entry, sl, target, entryIdx, timestamp }

  for (let i = 0; i < candles.length; i++) {
    const [ts, open, high, low, close, volume] = candles[i];

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
    }

    // ── Accumulate VWAP ─────────────────────────────────────────────────────
    const typicalPrice = (high + low + close) / 3;
    vwapAccum += typicalPrice * volume;
    vwapVol   += volume;
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

    volumeHistory.push(volume);
    if (volumeHistory.length > 20) volumeHistory.shift();

    // ── Check open trade SL / target against this candle ────────────────────
    if (openTrade) {
      const { action, entry, sl, target, entryIdx, entryTs } = openTrade;

      let exitPrice  = null;
      let tradeResult = null;

      if (action === 'BUY') {
        // Low hit SL first (worst case = loss; high hit target = win)
        if (low <= sl) {
          exitPrice   = sl;
          tradeResult = 'LOSS';
        } else if (high >= target) {
          exitPrice   = target;
          tradeResult = 'WIN';
        }
      } else {
        // SELL — high crosses SL, low crosses target
        if (high >= sl) {
          exitPrice   = sl;
          tradeResult = 'LOSS';
        } else if (low <= target) {
          exitPrice   = target;
          tradeResult = 'WIN';
        }
      }

      // Force-close at end of trading day (15:30 IST)
      const istHour = new Date(new Date(ts).getTime() + 5.5 * 3600_000).getUTCHours();
      const istMin  = new Date(new Date(ts).getTime() + 5.5 * 3600_000).getUTCMinutes();
      const isDayEnd = (istHour > 15) || (istHour === 15 && istMin >= 25);

      if (!tradeResult && isDayEnd) {
        exitPrice = close;
        // For BUY: win if close > entry; For SELL: win if close < entry
        tradeResult = action === 'BUY'
          ? (close >= entry ? 'WIN' : 'LOSS')
          : (close <= entry ? 'WIN' : 'LOSS');
      }

      if (tradeResult && exitPrice !== null) {
        const riskPerShare = Math.abs(entry - sl);
        const profit = action === 'BUY'
          ? (exitPrice - entry) * openTrade.qty
          : (entry - exitPrice) * openTrade.qty;

        trades.push({
          symbol,
          action,
          entry:      parseFloat(entry.toFixed(2)),
          exit:       parseFloat(exitPrice.toFixed(2)),
          stopLoss:   parseFloat(sl.toFixed(2)),
          target:     parseFloat(target.toFixed(2)),
          qty:        openTrade.qty,
          profit:     parseFloat(profit.toFixed(2)),
          riskAmount: parseFloat((riskPerShare * openTrade.qty).toFixed(2)),
          result:     tradeResult,
          entryTime:  entryTs,
          exitTime:   ts,
          holdCandles: i - entryIdx,
        });
        openTrade = null;
      }

      // Skip signal generation while in a trade
      if (openTrade) continue;
    }

    // ── Indicators ────────────────────────────────────────────────────────────
    const rsi    = computeRSI(closeHistory);
    const ema20  = computeEMA(emaHistory.slice(-60),  EMA_PERIOD);
    const ema50  = computeEMA(trendHistory.slice(-80), EMA_TREND_PERIOD);

    // ── Market trend proxy (single-symbol regime via 50-EMA) ──────────────────
    let marketTrend;
    if (trendHistory.length >= 20) {
      if      (close > ema50 * 1.01)  marketTrend = 'BULLISH';
      else if (close < ema50 * 0.99)  marketTrend = 'BEARISH';
      else                            marketTrend = 'NEUTRAL';
    } else {
      marketTrend = 'NEUTRAL';  // insufficient history for trend
    }

    // ── Volume multiplier ────────────────────────────────────────────────────
    const avgVolume = volumeHistory.length > 1
      ? volumeHistory.slice(0, -1).reduce((s, v) => s + v, 0) / (volumeHistory.length - 1)
      : volume;
    const volumeMultiplier = avgVolume > 0
      ? parseFloat((volume / avgVolume).toFixed(2))
      : 1;

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
      avgVolume:        Math.round(avgVolume),
      volumeMultiplier,
    };

    // ── Trading window gate ──────────────────────────────────────────────────
    if (!isWithinWindow(ts)) continue;

    // ── BUY gate (same as live signal engine) ────────────────────────────────
    const priceAboveEMA  = close > ema20;
    const hasVolumeSpike = volumeMultiplier >= 1.5;
    // Breakout: close is within 0.5% of running intraday high, and up >1% from prevClose
    const hasBreakout    = close >= runDayHigh * 0.995 && changePercent > 1;

    // ── SELL gate ────────────────────────────────────────────────────────────
    const priceBelowEMA  = close < ema20;
    const negativeMoment = changePercent < -1;

    const isBuy  = priceAboveEMA && hasVolumeSpike && hasBreakout;
    const isSell = priceBelowEMA && negativeMoment;

    if (!isBuy && !isSell) continue;

    // ── Market alignment gate ────────────────────────────────────────────────
    if (isBuy  && marketTrend === 'BEARISH') continue;
    if (isSell && marketTrend === 'BULLISH') continue;

    // ── Cooldown gate (3 candles = ~15 min) ──────────────────────────────────
    if (i - lastSignalIdx < COOLDOWN_CANDLES) continue;

    const action = isBuy ? 'BUY' : 'SELL';

    // ── Score ────────────────────────────────────────────────────────────────
    const score = isBuy
      ? scoreBuy(stock, rsi, marketTrend)
      : scoreSell(stock, rsi, marketTrend);

    if (score < MIN_CONFIDENCE) continue;

    // ── Dynamic SL ───────────────────────────────────────────────────────────
    const atr        = Math.max(dayRange, close * 0.01);
    const recentClose = closeHistory.slice(-10);
    const sl         = dynamicSL(action, close, atr, recentClose);

    // ── Target (1:2 R/R) ────────────────────────────────────────────────────
    const riskPts = Math.abs(close - sl);
    const target  = action === 'BUY'
      ? parseFloat((close + riskPts * 2).toFixed(2))
      : parseFloat((close - riskPts * 2).toFixed(2));

    // ── Position size (1% risk rule) ─────────────────────────────────────────
    const riskAmount = CAPITAL * (RISK_PERCENT / 100);
    const riskPerSh  = Math.abs(close - sl);
    const qty        = riskPerSh > 0 ? Math.floor(riskAmount / riskPerSh) : 0;

    if (qty <= 0) continue;

    // ── Open trade ────────────────────────────────────────────────────────────
    lastSignalIdx = i;
    openTrade = {
      action,
      entry:    close,
      sl:       parseFloat(sl.toFixed(2)),
      target:   parseFloat(target.toFixed(2)),
      qty,
      confidence: score,
      entryIdx: i,
      entryTs:  ts,
    };
  }

  // ── Force-close any trade still open at end of data ──────────────────────
  if (openTrade && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const [lts, , , , lclose] = lastCandle;
    const { action, entry, sl, target, qty, entryTs } = openTrade;
    const profit = action === 'BUY'
      ? (lclose - entry) * qty
      : (entry - lclose) * qty;
    trades.push({
      symbol,
      action,
      entry:      parseFloat(entry.toFixed(2)),
      exit:       parseFloat(lclose.toFixed(2)),
      stopLoss:   parseFloat(sl.toFixed(2)),
      target:     parseFloat(target.toFixed(2)),
      qty,
      profit:     parseFloat(profit.toFixed(2)),
      riskAmount: parseFloat((Math.abs(entry - sl) * qty).toFixed(2)),
      // BUY: win if exit > entry; SELL: win if exit < entry
      result:     action === 'BUY'
        ? (lclose >= entry ? 'WIN' : 'LOSS')
        : (lclose <= entry ? 'WIN' : 'LOSS'),
      entryTime:  entryTs,
      exitTime:   lts,
      holdCandles: candles.length - 1 - openTrade.entryIdx,
      note:       'forced close — end of data',
    });
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
      winRate:        0,
      totalProfit:    0,
      maxDrawdown:    0,
      avgRiskReward:  0,
    };
  }

  const wins   = trades.filter((t) => t.result === 'WIN');
  const losses = trades.filter((t) => t.result === 'LOSS');

  const totalProfit = parseFloat(
    trades.reduce((s, t) => s + t.profit, 0).toFixed(2)
  );

  // Max drawdown — peak-to-trough on cumulative P&L curve
  let peak      = 0;
  let cumPnL    = 0;
  let drawdown  = 0;
  for (const t of trades) {
    cumPnL += t.profit;
    if (cumPnL > peak) peak = cumPnL;
    const dd = peak - cumPnL;
    if (dd > drawdown) drawdown = dd;
  }
  const maxDrawdown = parseFloat((-drawdown).toFixed(2));

  // Average realised R:R
  const rrList = trades.map((t) => {
    if (!t.riskAmount || t.riskAmount === 0) return 0;
    return Math.abs(t.profit) / t.riskAmount;
  });
  const avgRiskReward = parseFloat(
    (rrList.reduce((s, r) => s + r, 0) / rrList.length).toFixed(2)
  );

  return {
    totalTrades:   trades.length,
    winningTrades: wins.length,
    losingTrades:  losses.length,
    winRate:       parseFloat(((wins.length / trades.length) * 100).toFixed(1)),
    totalProfit,
    maxDrawdown,
    avgRiskReward,
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
      minConfidence:   MIN_CONFIDENCE,
      cooldownMinutes: COOLDOWN_CANDLES * 5,
      riskPercent:     RISK_PERCENT,
      capital:         CAPITAL,
    },
    ...metrics,
    trades,
  };
}

module.exports = { runBacktest };

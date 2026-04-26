'use strict';

/**
 * Signal Engine — High-Accuracy NSE Strategy
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  FIVE-CONDITION SCORING SYSTEM (max 100 pts)                            │
 * │                                                                         │
 * │  Base (entry gate met):              20 pts  (guaranteed when gate fires)│
 * │  1. Market trend (NIFTY breadth):    +20 pts  BULLISH/BEARISH aligned    │
 * │                                      +5  pts  NEUTRAL (both allowed)     │
 * │  2. VWAP confirmation:               +15 pts  (price above/below VWAP)   │
 * │  3. RSI-14 optimal zone:             +15 pts  (40–65 BUY / 35–60 SELL)   │
 * │  4. Volume quality (≥ 2× average):   +12 pts  (≥3×:+12 / ≥2×:+10 /      │
 * │                                               1.5–2×:+5)                │
 * │  5. EMA-20 fresh breakout/breakdown: +10 pts  (gap < 3% = fresh cross)   │
 * │                                                                         │
 * │  MIN_CONFIDENCE = 75  — STRONG signals only (NEUTRAL market allowed)    │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  ADDITIONAL FILTERS                                                     │
 * │  • Time window:  9:30 AM – 3:15 PM IST only                             │
 * │  • Cooldown:     15 min per symbol (no repeat flood)                    │
 * │  • Market trend: BUY/SELL blocked only if DIRECTLY opposed (BEAR/BULL)  │
 * │  • Dynamic SL:   swing low/high (5+ candle history) or ATR × 1.5       │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const { calculatePositionSize } = require('./riskManager');
const { log }                   = require('../services/logger');

// ─── Config ───────────────────────────────────────────────────────────────────

const MIN_CONFIDENCE    = 75;   // STRONG signals; NEUTRAL market allowed (slightly lower bar)
const RSI_PERIOD        = 14;
const EMA_PULLBACK_ZONE = 2.0;  // max % price may deviate from EMA20 before entry is overextended
const PRICE_HISTORY_MAX = 60;   // rolling window per symbol
const COOLDOWN_MS       = 15 * 60 * 1000;   // 15-minute repeat-signal block

// Trading window (IST): 9:30 AM – 3:15 PM
const WINDOW_START_MINS = 9 * 60 + 30;   // 570
const WINDOW_END_MINS   = 15 * 60 + 15;  // 915
// Swing trading: no entry cutoff — signals allowed throughout market hours.

// ─── Per-run in-memory state ──────────────────────────────────────────────────

const _priceHistory   = {};  // symbol → number[]  (oldest-first)
const _lastSignalTime = {};  // symbol → epoch ms

// ─── Time filter ──────────────────────────────────────────────────────────────

/**
 * Returns true between 9:30 AM and 3:15 PM IST.
 */
function isWithinTradingWindow() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= WINDOW_START_MINS && mins <= WINDOW_END_MINS;
}

// ─── Cooldown ─────────────────────────────────────────────────────────────────

function isOnCooldown(symbol) {
  const last = _lastSignalTime[symbol];
  return last != null && (Date.now() - last) < COOLDOWN_MS;
}

function markSignalTime(symbol) {
  _lastSignalTime[symbol] = Date.now();
}

// ─── Price history & RSI ──────────────────────────────────────────────────────

/**
 * Append price to rolling history. Seeds with prevClose on first encounter
 * so RSI is immediately computable (avoids 14-cycle warmup delay).
 */
function updatePriceHistory(symbol, price, seedPrice) {
  if (!_priceHistory[symbol]) {
    const seed = seedPrice || price;
    // Pre-fill with seed so RSI(14) returns a neutral ~50 from cycle 1
    _priceHistory[symbol] = new Array(RSI_PERIOD + 1).fill(seed);
  }
  _priceHistory[symbol].push(price);
  if (_priceHistory[symbol].length > PRICE_HISTORY_MAX) {
    _priceHistory[symbol].shift();
  }
}

/**
 * Compute RSI-14 from a close-price array (oldest-first).
 * Returns null if insufficient data, or 0–100.
 */
function computeRSI(prices) {
  if (!prices || prices.length < RSI_PERIOD + 1) return null;

  let gains = 0;
  let losses = 0;
  const slice = prices.slice(-(RSI_PERIOD + 1)); // last 15 closes

  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff > 0) gains  += diff;
    else          losses -= diff;  // losses stored as positive
  }

  const avgGain = gains  / RSI_PERIOD;
  const avgLoss = losses / RSI_PERIOD;

  if (avgGain === 0 && avgLoss === 0) return 50;  // flat market → neutral
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;

  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(1));
}

// ─── Market trend (breadth) ───────────────────────────────────────────────────

/**
 * Determine overall market trend from the stock universe.
 *   ≥ 60% stocks above EMA20 → BULLISH
 *   ≤ 40% stocks above EMA20 → BEARISH
 *   Otherwise                → NEUTRAL
 *
 * @param {Array} stocks
 * @returns {'BULLISH'|'BEARISH'|'NEUTRAL'}
 */
function computeMarketTrend(stocks) {
  let aboveEMA = 0;
  let withEMA  = 0;

  for (const s of stocks) {
    if (s.ema20 != null) {
      withEMA++;
      if (s.price > s.ema20) aboveEMA++;
    }
  }

  if (withEMA === 0) return 'NEUTRAL';
  const ratio = aboveEMA / withEMA;
  if (ratio >= 0.60) return 'BULLISH';
  if (ratio <= 0.40) return 'BEARISH';
  return 'NEUTRAL';
}

// ─── Dynamic Stop Loss ────────────────────────────────────────────────────────

/**
 * Compute a dynamic stop-loss price using:
 *   • Swing low/high (last 10 candles, if ≥ 5 exist)  ← preferred
 *   • ATR × 1.5 from entry                            ← fallback
 *   • Hard cap: max 3% from entry (position-size safety)
 *
 * @param {'BUY'|'SELL'} action
 * @param {number} price    current price
 * @param {number} atr      day range approximation
 * @param {string} symbol
 * @returns {number} stop-loss price
 */
function dynamicSL(action, price, atr, symbol) {
  const hist    = _priceHistory[symbol] || [];
  const recent  = hist.slice(-10);
  const hasSuff = recent.length >= 5;

  const maxSlip = price * 0.03; // hard cap: 3% from entry

  if (action === 'BUY') {
    const atrSL   = price - Math.min(atr * 1.5, maxSlip);
    if (!hasSuff) return parseFloat(atrSL.toFixed(2));

    const swingLow = Math.min(...recent);
    const swingSL  = swingLow * 0.998;              // 0.2% buffer below swing

    // Use the tighter (higher) SL — less risk, still technical
    const sl = Math.max(swingSL, atrSL);
    return parseFloat(Math.max(sl, price - maxSlip).toFixed(2));
  }

  // SELL
  const atrSL = price + Math.min(atr * 1.5, maxSlip);
  if (!hasSuff) return parseFloat(atrSL.toFixed(2));

  const swingHigh = Math.max(...recent);
  const swingSL   = swingHigh * 1.002;              // 0.2% buffer above swing

  const sl = Math.min(swingSL, atrSL);
  return parseFloat(Math.min(sl, price + maxSlip).toFixed(2));
}

// ─── Strength label ───────────────────────────────────────────────────────────

function strengthLabel(confidence) {
  if (confidence >= 80) return 'STRONG';
  if (confidence >= 60) return 'MEDIUM';
  return 'WEAK';
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Score a BUY signal.
 *
 * Max score breakdown:
 *   Base (BUY gate confirmed):       20
 *   Market BULLISH:                 +20 (NEUTRAL: +5, BEARISH: blocked upstream)
 *   Price above VWAP:               +15
 *   RSI 40–65 (ideal buy zone):     +15
 *   Volume ≥ 3× (institutional):    +12 (≥ 2×: +10; 1.5–2×: +5)
 *   EMA-20 fresh breakout (< 3%):   +10 (extended > 3%: only +3)
 *                                  ────
 *   Maximum possible:               97 (BULLISH) / 82 (NEUTRAL)
 */
function scoreBuy(stock, rsi, marketTrend) {
  let   score   = 20;  // base
  const reasons = [];
  const missed  = [];  // conditions that cost points

  // 1. Market trend
  if (marketTrend === 'BULLISH') {
    score += 20;
    reasons.push('Market breadth: BULLISH (≥60% stocks above EMA20)');
  } else {
    // NEUTRAL — allowed with reduced bonus; BEARISH is blocked upstream
    score += 5;
    reasons.push('Market breadth: NEUTRAL (−5 penalty vs aligned market)');
    missed.push('market not BULLISH (−15 vs ideal)');
  }

  // 2. VWAP confirmation
  if (stock.vwap != null && stock.price > stock.vwap) {
    score += 15;
    reasons.push(`Price above VWAP ₹${stock.vwap} — bullish intraday bias`);
  } else {
    missed.push(
      stock.vwap != null
        ? `price ₹${stock.price} below VWAP ₹${stock.vwap} (−15)`
        : 'VWAP unavailable (−15)'
    );
  }

  // 3. RSI filter
  if (rsi !== null) {
    if (rsi >= 40 && rsi <= 65) {
      score += 15;
      reasons.push(`RSI ${rsi} — ideal BUY zone (40–65), momentum without overbought`);
    } else if (rsi > 65 && rsi <= 75) {
      score += 7;
      reasons.push(`RSI ${rsi} — elevated, watch for exhaustion`);
      missed.push(`RSI ${rsi} elevated >65 (−8 vs ideal)`);
    } else if (rsi > 75) {
      reasons.push(`RSI ${rsi} — overbought, no RSI bonus`);
      missed.push(`RSI ${rsi} overbought >75 (−15)`);
    } else {
      reasons.push(`RSI ${rsi} — below 40, weak momentum`);
      missed.push(`RSI ${rsi} weak <40 (−15)`);
    }
  } else {
    missed.push('RSI not yet available (−15)');
  }

  // 4. Volume quality
  const vm = stock.volumeMultiplier;
  if (vm >= 3.0) {
    score += 12;
    reasons.push(`Volume ${vm.toFixed(1)}x — very strong institutional buying`);
  } else if (vm >= 2.0) {
    score += 10;
    reasons.push(`Volume ${vm.toFixed(1)}x — strong buying pressure`);
    missed.push(`volume ${vm.toFixed(1)}x < 3× (−2 vs ideal)`);
  } else {
    score += 5;
    reasons.push(`Volume ${vm.toFixed(1)}x — moderate (≥ 2× preferred)`);
    missed.push(`low volume ${vm.toFixed(1)}x < 2× (−7 vs ideal)`);
  }

  // 5. EMA-20 breakout quality
  const ema20    = stock.ema20 || stock.price;
  const emaGapPc = ((stock.price - ema20) / ema20) * 100;
  if (emaGapPc >= 0 && emaGapPc <= 3) {
    score += 10;
    reasons.push(`Fresh EMA20 breakout — ${emaGapPc.toFixed(2)}% above EMA (clean cross)`);
  } else if (emaGapPc > 3) {
    score += 3;
    reasons.push(`Extended ${emaGapPc.toFixed(2)}% above EMA20 — momentum but stretched`);
    missed.push(`EMA gap ${emaGapPc.toFixed(2)}% extended >3% (−7 vs ideal)`);
  } else {
    missed.push(`price below EMA20 — no EMA breakout bonus (−10)`);
  }

  return { score: Math.min(score, 100), reasons, missed };
}

/**
 * Score a SELL signal.
 *
 * Max score breakdown:
 *   Base (SELL gate confirmed):      20
 *   Market BEARISH:                 +20 (NEUTRAL: +5, BULLISH: blocked upstream)
 *   Price below VWAP:               +15
 *   RSI 35–60 (ideal sell zone):    +15
 *   Volume ≥ 3× (distribution):     +12 (≥ 2×: +10; 1.5–2×: +5)
 *   EMA-20 fresh breakdown (< 3%):  +10 (extended > 3%: only +3)
 *                                  ────
 *   Maximum possible:               97 (BEARISH) / 82 (NEUTRAL)
 */
function scoreSell(stock, rsi, marketTrend) {
  let   score   = 20;
  const reasons = [];
  const missed  = [];  // conditions that cost points

  // 1. Market trend
  if (marketTrend === 'BEARISH') {
    score += 20;
    reasons.push('Market breadth: BEARISH (≥60% stocks below EMA20)');
  } else {
    // NEUTRAL — allowed with reduced bonus; BULLISH is blocked upstream
    score += 5;
    reasons.push('Market breadth: NEUTRAL (−5 penalty vs aligned market)');
    missed.push('market not BEARISH (−15 vs ideal)');
  }

  // 2. Below VWAP
  if (stock.vwap != null && stock.price < stock.vwap) {
    score += 15;
    reasons.push(`Price below VWAP ₹${stock.vwap} — bearish intraday bias`);
  } else {
    missed.push(
      stock.vwap != null
        ? `price ₹${stock.price} above VWAP ₹${stock.vwap} (−15)`
        : 'VWAP unavailable (−15)'
    );
  }

  // 3. RSI filter
  if (rsi !== null) {
    if (rsi >= 35 && rsi <= 60) {
      score += 15;
      reasons.push(`RSI ${rsi} — ideal SELL zone (35–60), downward without oversold`);
    } else if (rsi >= 25 && rsi < 35) {
      score += 7;
      reasons.push(`RSI ${rsi} — approaching oversold, consider partial`);
      missed.push(`RSI ${rsi} near oversold <35 (−8 vs ideal)`);
    } else if (rsi < 25) {
      reasons.push(`RSI ${rsi} — oversold, high reversal risk, no RSI bonus`);
      missed.push(`RSI ${rsi} oversold <25 (−15)`);
    } else {
      reasons.push(`RSI ${rsi} — above 60, weak sell momentum`);
      missed.push(`RSI ${rsi} too high >60 (−15)`);
    }
  } else {
    missed.push('RSI not yet available (−15)');
  }

  // 4. Volume quality (distribution / panic selling)
  const vm = stock.volumeMultiplier;
  if (vm >= 3.0) {
    score += 12;
    reasons.push(`Volume ${vm.toFixed(1)}x — heavy institutional distribution`);
  } else if (vm >= 2.0) {
    score += 10;
    reasons.push(`Volume ${vm.toFixed(1)}x — strong selling pressure`);
    missed.push(`volume ${vm.toFixed(1)}x < 3× (−2 vs ideal)`);
  } else if (vm >= 1.5) {
    score += 5;
    reasons.push(`Volume ${vm.toFixed(1)}x — moderate selling`);
    missed.push(`low volume ${vm.toFixed(1)}x < 2× (−7 vs ideal)`);
  } else {
    missed.push(`very low volume ${vm.toFixed(1)}x < 1.5× (−12)`);
  }

  // 5. EMA-20 breakdown quality
  const ema20    = stock.ema20 || stock.price;
  const emaGapPc = ((ema20 - stock.price) / ema20) * 100;
  if (emaGapPc >= 0 && emaGapPc <= 3) {
    score += 10;
    reasons.push(`Fresh EMA20 breakdown — ${emaGapPc.toFixed(2)}% below EMA (clean cross)`);
  } else if (emaGapPc > 3) {
    score += 3;
    reasons.push(`Extended ${emaGapPc.toFixed(2)}% below EMA20 — trend confirmed but stretched`);
    missed.push(`EMA gap ${emaGapPc.toFixed(2)}% extended >3% (−7 vs ideal)`);
  } else {
    missed.push(`price above EMA20 — no EMA breakdown bonus (−10)`);
  }

  return { score: Math.min(score, 100), reasons, missed };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Generate high-accuracy trading signals from a market snapshot.
 *
 * @param {Array}  stocks   Market snapshot (ema20 attached by marketScanner)
 * @param {Object} scanData { topGainers, volumeSpikes, breakouts, vwapBreakouts, emaCrosses }
 * @returns {Array<Object>} Signals sorted by confidence desc, empty [] outside window
 */
function generateSignals(stocks, scanData) {
  const { volumeSpikes, breakouts, vwapBreakouts } = scanData;

  // ── Time gate ─────────────────────────────────────────────────────────────
  if (!isWithinTradingWindow()) {
    console.log('[SignalEngine] ⏰ Outside trading window (9:30–15:15 IST). No signals generated.');
    return [];
  }

  // ── Market trend (breadth) ────────────────────────────────────────────────
  const marketTrend = computeMarketTrend(stocks);
  console.log(`[SignalEngine] Market breadth: ${marketTrend}`);

  const breakoutSymbols = new Set(breakouts.map((s) => s.symbol));
  const spikeSymbols    = new Set(volumeSpikes.map((s) => s.symbol));
  const vwapSymbols     = new Set((vwapBreakouts || []).map((s) => s.symbol));

  const signals = [];

  for (const stock of stocks) {
    const ema20 = stock.ema20 ?? null;

    // ── Update price history + compute RSI ───────────────────────────────────
    updatePriceHistory(stock.symbol, stock.price, stock.prevClose);
    const rsi = computeRSI(_priceHistory[stock.symbol]);

    // ── BUY gate: pullback-to-EMA strategy ──────────────────────────────────
    // Overextension filter: if price is > EMA_PULLBACK_ZONE% from EMA20,
    // the move is already extended — skip regardless of direction.
    const emaDistPct = (ema20 !== null && ema20 > 0)
      ? Math.abs((stock.price - ema20) / ema20) * 100
      : 999;
    if (emaDistPct > EMA_PULLBACK_ZONE) {
      console.log(`[SignalEngine] ↔ ${stock.symbol} SKIP — price ${emaDistPct.toFixed(2)}% from EMA20 (overextended, limit ±${EMA_PULLBACK_ZONE}%)`);
      log('SIGNAL', 'Signal rejected', {
        symbol: stock.symbol,
        reason: `overextended ${emaDistPct.toFixed(2)}% from EMA20 (limit ±${EMA_PULLBACK_ZONE}%)`,
      });
      continue;
    }

    // BUY: price above EMA20 but near it (trend up, pulling back to EMA),
    //      RSI confirms bullish momentum, day candle is bullish.
    const priceAboveEMA  = ema20 !== null && stock.price > ema20;
    const hasVolumeSpike = spikeSymbols.has(stock.symbol);     // vMult ≥ 1.5
    const rsiAbove50     = rsi !== null && rsi > 50;
    const bullishCandle  = stock.open != null && stock.price > stock.open;  // price above day open

    // ── SELL gate: pullback-to-EMA strategy ─────────────────────────────────
    // SELL: price below EMA20 but near it (trend down, rallying back to EMA),
    //       RSI confirms bearish momentum, day candle is bearish.
    const priceBelowEMA  = ema20 !== null && stock.price < ema20;
    const rsiBelow50     = rsi !== null && rsi < 50;
    const bearishCandle  = stock.open != null && stock.price < stock.open;  // price below day open

    const isBuy  = priceAboveEMA && rsiAbove50 && bullishCandle && hasVolumeSpike;
    const isSell = priceBelowEMA && rsiBelow50 && bearishCandle && hasVolumeSpike;

    if (!isBuy && !isSell) continue;

    // ── Market trend alignment gate ───────────────────────────────────────────
    // Block directly opposed trades; NEUTRAL allows both BUY and SELL (lower score)
    if (isBuy  && marketTrend === 'BEARISH') {
      console.log(`[SignalEngine] ⛔ ${stock.symbol} BUY blocked — market is BEARISH`);
      log('SIGNAL', 'Signal rejected', { symbol: stock.symbol, action: 'BUY', reason: 'market trend BEARISH (hard block)' });
      continue;
    }
    if (isSell && marketTrend === 'BULLISH') {
      console.log(`[SignalEngine] ⛔ ${stock.symbol} SELL blocked — market is BULLISH`);
      log('SIGNAL', 'Signal rejected', { symbol: stock.symbol, action: 'SELL', reason: 'market trend BULLISH (hard block)' });
      continue;
    }

    // ── Cooldown gate ─────────────────────────────────────────────────────────
    if (isOnCooldown(stock.symbol)) {
      const minsLeft = Math.ceil((COOLDOWN_MS - (Date.now() - _lastSignalTime[stock.symbol])) / 60_000);
      console.log(`[SignalEngine] ⏱  ${stock.symbol} on 15-min cooldown (${minsLeft} min remaining)`);
      log('SIGNAL', 'Signal rejected', { symbol: stock.symbol, reason: `cooldown (${minsLeft} min remaining)` });
      continue;
    }

    const action = isBuy ? 'BUY' : 'SELL';

    // ── Score signal ──────────────────────────────────────────────────────────
    const { score, reasons: condReasons, missed } = isBuy
      ? scoreBuy(stock, rsi, marketTrend)
      : scoreSell(stock, rsi, marketTrend);

    if (score < MIN_CONFIDENCE) {
      console.log(
        `[SignalEngine] ✗ ${stock.symbol} ${action} rejected | ` +
        `score=${score}/${MIN_CONFIDENCE} | ` +
        `missed: ${missed.length ? missed.join(', ') : 'none'}`
      );
      log('SIGNAL', 'Signal rejected', {
        symbol:  stock.symbol,
        action,
        score,
        threshold: MIN_CONFIDENCE,
        reason:  missed.length ? missed.join('; ') : 'score below threshold',
      });
      continue;
    }

    // ── Dynamic Stop Loss ─────────────────────────────────────────────────────
    const atr  = Math.max(stock.dayHigh - stock.dayLow, stock.price * 0.01); // min 1%
    const sl   = dynamicSL(action, stock.price, atr, stock.symbol);
    const slType = (_priceHistory[stock.symbol]?.length ?? 0) >= 5 ? 'swing+ATR' : 'ATR';

    // Target: 2× risk (1:2 R/R)
    const riskPoints = Math.abs(stock.price - sl);
    const target = action === 'BUY'
      ? parseFloat((stock.price + riskPoints * 2).toFixed(2))
      : parseFloat((stock.price - riskPoints * 2).toFixed(2));

    const risk = calculatePositionSize(stock.price, sl, target);

    // ── Mark cooldown before emitting ─────────────────────────────────────────
    markSignalTime(stock.symbol);

    // ── Build human-readable reasons ──────────────────────────────────────────
    const baseReasons = isBuy
      ? [
          `Price ${stock.price} > EMA20 ${ema20?.toFixed(2) ?? 'N/A'} (trend up, pullback near EMA)`,
          `EMA distance ${emaDistPct.toFixed(2)}% ≤ ${EMA_PULLBACK_ZONE}% (not overextended)`,
          `Bullish candle: price ${stock.price} > day open ${stock.open}`,
          `Volume spike ${stock.volumeMultiplier?.toFixed(1) ?? 'N/A'}x average`,
        ]
      : [
          `Price ${stock.price} < EMA20 ${ema20?.toFixed(2) ?? 'N/A'} (trend down, rally near EMA)`,
          `EMA distance ${emaDistPct.toFixed(2)}% ≤ ${EMA_PULLBACK_ZONE}% (not overextended)`,
          `Bearish candle: price ${stock.price} < day open ${stock.open}`,
        ];

    console.log(`[SignalEngine] ✅ ${action} ${stock.symbol} — score ${score}/100 | RSI ${rsi ?? 'N/A'} | SL: ₹${sl} (${slType})`);

    log('SIGNAL', 'Signal generated', {
      symbol:      stock.symbol,
      action,
      score,
      rsi:         rsi ?? null,
      marketTrend,
      price:       stock.price,
      stopLoss:    sl,
      target,
    });

    signals.push({
      symbol:           stock.symbol,
      action,
      strength:         strengthLabel(score),
      confidence:       score,
      price:            stock.price,
      changePercent:    stock.changePercent,
      volume:           stock.volume,
      avgVolume:        stock.avgVolume,
      volumeMultiplier: stock.volumeMultiplier,
      ema20,
      vwap:             stock.vwap  ?? null,
      rsi,
      marketTrend,
      entry:            stock.price,
      stopLoss:         sl,
      slType,
      target,
      rrRatio:          risk.rrRatio,
      positionSize:     risk.positionSize,
      positionValue:    risk.positionValue,
      riskAmount:       risk.riskAmount,
      riskPerShare:     risk.riskPerShare,
      rewardAmount:     risk.rewardAmount,
      capital:          risk.capital,
      riskPercent:      risk.riskPercent,
      reasons:          [...baseReasons, ...condReasons],
      source:           stock.source ?? 'unknown',
      timestamp:        stock.timestamp,
    });
  }

  // Sort highest confidence first
  return signals.sort((a, b) => b.confidence - a.confidence);
}

module.exports = { generateSignals };

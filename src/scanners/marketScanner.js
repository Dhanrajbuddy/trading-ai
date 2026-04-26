'use strict';

/**
 * Enhanced Market Scanner
 * Identifies: top gainers, volume spikes, breakouts, VWAP breakouts, 20 EMA crosses
 */

const GAINER_THRESHOLD  = 2;    // % change to qualify as a top gainer
const VOLUME_SPIKE_MULT = 1.5;  // volume multiplier threshold
const EMA_PERIOD        = 20;   // EMA period for trend filter

// ─── In-memory price history for EMA calculation ─────────────────────────────
// keyed by symbol, stores last EMA_PERIOD prices
const priceHistory = {};

/**
 * Compute Exponential Moving Average given a prices array and period
 * Uses standard EMA formula: EMA = price * k + prevEMA * (1 - k), k = 2/(n+1)
 * @param {number[]} prices  - ordered oldest-first
 * @param {number}   period
 * @returns {number}
 */
function computeEMA(prices, period) {
  if (prices.length === 0) return 0;
  const k    = 2 / (period + 1);
  let   ema  = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return parseFloat(ema.toFixed(2));
}

/**
 * Update rolling price history and return current 20 EMA for a stock.
 * Seeds history with prevClose on first encounter so EMA is meaningful
 * from the very first scan (no warmup delay).
 * @param {string} symbol
 * @param {number} price
 * @param {number} [seedPrice]  prevClose — used to pre-populate history once
 * @returns {number} ema20
 */
function getEMA20(symbol, price, seedPrice) {
  if (!priceHistory[symbol]) {
    // Pre-seed with prevClose so EMA diverges from current price immediately
    const seed = seedPrice || price;
    priceHistory[symbol] = new Array(EMA_PERIOD).fill(seed);
  }
  priceHistory[symbol].push(price);
  if (priceHistory[symbol].length > EMA_PERIOD * 3) {
    priceHistory[symbol].shift(); // prevent unbounded growth
  }
  return computeEMA(priceHistory[symbol], EMA_PERIOD);
}

// ─── Scanners ─────────────────────────────────────────────────────────────────

/**
 * Top gainers (changePercent > threshold)
 */
function scanTopGainers(stocks) {
  return stocks
    .filter((s) => s.changePercent > GAINER_THRESHOLD)
    .sort((a, b) => b.changePercent - a.changePercent);
}

/**
 * Unusual volume spikes (volumeMultiplier > threshold)
 */
function scanVolumeSpikes(stocks) {
  return stocks
    .filter((s) => s.volumeMultiplier > VOLUME_SPIKE_MULT)
    .sort((a, b) => b.volumeMultiplier - a.volumeMultiplier);
}

/**
 * Price breakout above day high with positive momentum
 */
function scanBreakouts(stocks) {
  return stocks.filter(
    (s) => s.price >= s.dayHigh * 0.995 && s.changePercent > 1
  );
}

/**
 * VWAP breakout — price above VWAP is bullish intraday confirmation
 * Falls back gracefully when vwap is not present (mock data without it)
 */
function scanVWAPBreakouts(stocks) {
  return stocks.filter(
    (s) => s.vwap != null && s.price > s.vwap && s.changePercent > 0.5
  );
}

/**
 * 20 EMA cross — price crossed above its 20-period EMA
 * Mutates stock objects to attach ema20 for downstream use
 */
function scanEMACrosses(stocks) {
  return stocks.filter((s) => {
    const ema20  = getEMA20(s.symbol, s.price, s.prevClose); // seed with prevClose
    s.ema20      = ema20;                       // attach for signal engine
    return s.price > ema20 && s.changePercent > 0;
  });
}

/**
 * Run all scanners and return categorised results
 * @param {Array} stocks
 * @returns {Object}
 */
function runScanners(stocks) {
  const topGainers    = scanTopGainers(stocks);
  const volumeSpikes  = scanVolumeSpikes(stocks);
  const breakouts     = scanBreakouts(stocks);
  const vwapBreakouts = scanVWAPBreakouts(stocks);
  const emaCrosses    = scanEMACrosses(stocks);   // mutates stocks with ema20

  return { topGainers, volumeSpikes, breakouts, vwapBreakouts, emaCrosses };
}

module.exports = {
  runScanners,
  scanTopGainers,
  scanVolumeSpikes,
  scanBreakouts,
  scanVWAPBreakouts,
  scanEMACrosses,
};

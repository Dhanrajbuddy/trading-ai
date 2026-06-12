'use strict';

/**
 * orbCore.js — Single source of truth for all ORB strategy constants and logic.
 *
 * Both signalEngine.js (live) and backtestEngine.js import from here.
 * Any change to strategy parameters or entry/exit logic made here automatically
 * applies to both systems, preventing drift.
 *
 * What lives here:
 *   - All strategy constants (ORB_BUFFER_PCT, SL_PCT, etc.)
 *   - scoreSignal()     — signal quality scoring
 *   - calcTradingCosts() — Zerodha NSE intraday cost model
 *   - computeRSI()       — standard 14-period RSI
 *   - orbSL()            — ORB-based stop loss placement
 *   - orbTarget()        — dynamic 2× ORB range target
 *   - BULL_MARKET_THRESHOLD — Nifty trend filter constant
 *
 * What does NOT live here:
 *   - In-memory candle state (live system only)
 *   - Zerodha API calls
 *   - Logging / alerting side-effects
 */

// ─── Strategy Constants ───────────────────────────────────────────────────────

const MIN_CONFIDENCE      = 68;    // requires base(40) + RSI-moderate(10) + vol-spike(8) at minimum
                                    // evidence: at 60, signals with only volume spike passed — no RSI quality
const VOLUME_SPIKE_MIN    = 1.5;
const SL_PCT              = 0.5;   // fixed SL: 0.5% from entry
const TARGET_MULT         = 2.0;   // target = 2× ORB range from entry
const TARGET_PCT_FALLBACK = 1.0;   // fallback when ORB range < 0.5%
const ORB_CANDLES         = 2;     // first 2 × 15-min candles form the range
const ORB_BUFFER_PCT      = 0.10;  // breakout must be 0.10% beyond ORB
const ORB_MIN_RANGE_PCT   = 0.30;  // minimum ORB width as % of price
                                    // evidence: 12/16 paper trade SL-hits had ORB range < 0.5%
                                    // tight ORBs → SL is within normal intraday noise → frequent false stops
const RSI_PERIOD          = 14;
const MAX_TRADES_PER_DAY  = 2;
const COOLDOWN_MINS       = 30;    // minutes between signals per symbol

// Trading window constants (IST minutes since midnight)
const WINDOW_START_MINS   = 9  * 60 + 30;  // 9:30 AM — after ORB established
const ENTRY_CUTOFF_MINS   = 14 * 60 + 30;  // 2:30 PM — no new entries after this
const CLOSE_ALL_MINS      = 15 * 60 + 15;  // 3:15 PM Zerodha auto-squareoff

// Nifty trend filter: ≥55% of stocks above VWAP → bull market → suppress SELL signals
const BULL_MARKET_THRESHOLD = 0.55;

// ─── Zerodha NSE Intraday Cost Model ─────────────────────────────────────────
// Slippage 0.10% per side, brokerage 0.03% capped at ₹20, STT 0.025% sell-side,
// NSE exchange charges 0.00325% per side, GST 18% on brokerage+exchange.

function calcTradingCosts(action, entryPrice, exitPrice, qty) {
  const entryVal   = entryPrice * qty;
  const exitVal    = exitPrice  * qty;
  const slippage   = (entryVal + exitVal) * 0.0010;
  const brokEntry  = Math.min(entryVal * 0.0003, 20);
  const brokExit   = Math.min(exitVal  * 0.0003, 20);
  const sellVal    = action === 'BUY' ? exitVal : entryVal;
  const stt        = sellVal * 0.00025;
  const exchCharges = (entryVal + exitVal) * 0.0000325;
  const gst        = (brokEntry + brokExit + exchCharges) * 0.18;
  return parseFloat((slippage + brokEntry + brokExit + stt + exchCharges + gst).toFixed(2));
}

// ─── RSI (14-period simple, candle closes) ────────────────────────────────────

function computeRSI(prices) {
  if (!prices || prices.length < RSI_PERIOD + 1) return null;
  const slice = prices.slice(-(RSI_PERIOD + 1));
  let gains = 0, losses = 0;
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

// ─── Signal Scoring ───────────────────────────────────────────────────────────
//
// Base: 40 (all hard ORB gates passed — breakout above/below range + volume spike)
// +20 RSI quality  (strong momentum in breakout direction, not at extremes)
// +10 RSI moderate (moderate momentum)
// +20 Volume       (≥3× = institutional conviction)
// +15 Volume       (≥2×)
// +8  Volume       (≥1.5× — minimum spike gate, partial bonus)
// +20 VWAP aligned (price on correct side of intraday VWAP)
//
// Max = 100. Min to trade = MIN_CONFIDENCE (60).
// A signal scoring 60 has: breakout confirmed + volume spike + at least one of (RSI moderate / VWAP).
// A signal scoring 80+ has: breakout + strong volume + RSI momentum + VWAP alignment.

function scoreSignal(action, { rsi, volumeMultiplier, price, vwap }) {
  let score = 40;

  // RSI quality
  if (rsi !== null) {
    if (action === 'BUY') {
      if      (rsi >= 60 && rsi <= 72) score += 20;  // strong bullish, not overbought
      else if (rsi >= 50)              score += 10;   // moderate bullish
    } else {
      if      (rsi >= 28 && rsi <= 40) score += 20;  // strong bearish, not oversold
      else if (rsi <= 50)              score += 10;   // moderate bearish
    }
  }

  // Volume quality
  if (volumeMultiplier != null) {
    if      (volumeMultiplier >= 3.0) score += 20;
    else if (volumeMultiplier >= 2.0) score += 15;
    else if (volumeMultiplier >= 1.5) score += 8;
  }

  // VWAP alignment
  if (vwap != null && price != null) {
    const aligned = (action === 'BUY' && price > vwap) ||
                    (action === 'SELL' && price < vwap);
    if (aligned) score += 20;
  }

  return Math.min(score, 100);
}

// ─── SL / Target Helpers ─────────────────────────────────────────────────────

/**
 * Fixed-percentage stop loss (current system).
 * @returns {number} stop loss price
 */
function fixedSL(action, entry) {
  return action === 'BUY'
    ? parseFloat((entry * (1 - SL_PCT / 100)).toFixed(2))
    : parseFloat((entry * (1 + SL_PCT / 100)).toFixed(2));
}

/**
 * Dynamic target: 2× ORB range from entry. Falls back to TARGET_PCT_FALLBACK
 * when ORB range is too narrow (< TARGET_PCT_FALLBACK / TARGET_MULT %).
 * @returns {{ target: number, targetPct: number }}
 */
function dynamicTarget(action, entry, orbHigh, orbLow) {
  const orbRange     = orbHigh - orbLow;
  const orbRangePct  = (orbRange / entry) * 100;
  const targetPct    = Math.max(orbRangePct * TARGET_MULT, TARGET_PCT_FALLBACK);
  const target       = action === 'BUY'
    ? parseFloat((entry * (1 + targetPct / 100)).toFixed(2))
    : parseFloat((entry * (1 - targetPct / 100)).toFixed(2));
  return { target, targetPct: parseFloat(targetPct.toFixed(2)) };
}

/**
 * IST minutes since midnight from an ISO timestamp string or Date.
 */
function getCandleMinsIST(ts) {
  const d   = new Date(ts);
  const ist = new Date(d.getTime() + 5.5 * 3600_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Constants
  MIN_CONFIDENCE,
  VOLUME_SPIKE_MIN,
  SL_PCT,
  TARGET_MULT,
  TARGET_PCT_FALLBACK,
  ORB_CANDLES,
  ORB_BUFFER_PCT,
  ORB_MIN_RANGE_PCT,
  RSI_PERIOD,
  MAX_TRADES_PER_DAY,
  COOLDOWN_MINS,
  WINDOW_START_MINS,
  ENTRY_CUTOFF_MINS,
  CLOSE_ALL_MINS,
  BULL_MARKET_THRESHOLD,
  // Functions
  calcTradingCosts,
  computeRSI,
  scoreSignal,
  fixedSL,
  dynamicTarget,
  getCandleMinsIST,
};

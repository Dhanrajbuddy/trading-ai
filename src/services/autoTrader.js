'use strict';

/**
 * autoTrader.js — Controlled Automated Signal Execution
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  ONLY executes when ALL of the following are true:                      ║
 * ║    1. AUTO_TRADING=true in environment                                  ║
 * ║    2. NSE market session is open (09:15–15:30 IST, Mon–Fri)             ║
 * ║    3. Signal confidence >= MIN_CONFIDENCE (80)                          ║
 * ║    4. Signal exchange is NSE (not BSE or other)                         ║
 * ║    5. Auto daily trade count < MAX_TRADES_PER_DAY (3)                   ║
 * ║    6. Symbol not already auto-traded today                              ║
 * ║    7. positionSize > 0 (risk manager computed a valid lot size)          ║
 * ║                                                                         ║
 * ║  After passing these gates, execution is fully delegated to             ║
 * ║  orderService.placeOrder() which runs its own safety checks             ║
 * ║  (Zerodha credentials, NSE whitelist, duplicate prevention, etc.)       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

const { placeOrder }           = require('./orderService');
const { isMarketOpen }         = require('../utils/marketStatus');
const { sendAutoTradeAlert }   = require('../alerts/telegramAlert');

// ─── Config ───────────────────────────────────────────────────────────────────

const MIN_CONFIDENCE    = 80;  // require STRONG signals only (signalEngine STRONG >= 80)
const MAX_TRADES_PER_DAY = 3;  // hard cap on auto-executions per calendar day

// ─── Daily state (resets at IST midnight) ────────────────────────────────────

let _day          = '';          // YYYY-MM-DD in IST
let _tradesToday  = 0;           // count of auto-executions placed today
let _tradedStocks = new Set();   // symbols auto-traded today (one trade per symbol)

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Return today's date as YYYY-MM-DD in IST (UTC+05:30). */
function todayIST() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

/** Reset counters when the calendar day rolls over. */
function refreshDay() {
  const today = todayIST();
  if (_day !== today) {
    _day          = today;
    _tradesToday  = 0;
    _tradedStocks = new Set();
    console.log(`[AutoTrader] New trading day: ${today}. Counters reset.`);
  }
}

/**
 * Log a skipped signal with the reason — never throws.
 * @param {string} symbol
 * @param {string} reason
 */
function skip(symbol, reason) {
  console.log(`[AutoTrader] ⏭  Skipped ${symbol || '?'}: ${reason}`);
}

// ─── Core function ────────────────────────────────────────────────────────────

/**
 * Evaluate an enriched signal and, if all safety gates pass, execute
 * a live order via orderService.placeOrder().
 *
 * This function NEVER throws — all errors are caught and logged so the
 * calling pipeline is never disrupted.
 *
 * @param {Object}  signal              Enriched signal from runPipeline
 * @param {string}  signal.symbol       Ticker, e.g. "RELIANCE" or "NSE:RELIANCE"
 * @param {string}  signal.action       "BUY" | "SELL"
 * @param {number}  signal.confidence   0–100 from signalEngine
 * @param {number}  [signal.analysis.confidence]  AI confidence (preferred if present)
 * @param {number}  signal.positionSize Shares to trade (from riskManager, 1% rule)
 * @param {number}  signal.entry        Entry price
 * @param {number}  signal.stopLoss     Stop-loss price
 * @param {number}  signal.target       Target price
 */
async function processSignal(signal) {
  // Wrap everything so the pipeline can never crash from auto-trading
  try {
    // ── Gate 1: Feature flag ────────────────────────────────────────────────
    if (process.env.AUTO_TRADING !== 'true') {
      // Silent return — flag being off is normal operating mode
      return;
    }

    // ── Gate 2: Market session ──────────────────────────────────────────────
    if (!isMarketOpen()) {
      skip(signal?.symbol, 'Market is closed (outside trading window 9:30–15:15 IST)');
      return;
    }

    // ── Normalise symbol early ──────────────────────────────────────────────
    const rawSymbol = signal?.symbol || '';
    const symbol    = rawSymbol.toUpperCase().replace(/^NSE:/, '');

    // ── Gate 3a: Confidence ─────────────────────────────────────────────────
    // Prefer AI analysis confidence when available; fall back to signal's own
    const confidence = signal?.analysis?.confidence ?? signal?.confidence ?? 0;
    if (confidence < MIN_CONFIDENCE) {
      skip(symbol, `Confidence ${confidence}% < required ${MIN_CONFIDENCE}%`);
      return;
    }

    // ── Gate 3b: NSE exchange only ──────────────────────────────────────────
    if (/^BSE:/i.test(rawSymbol)) {
      skip(symbol, 'Exchange is BSE — only NSE instruments allowed');
      return;
    }

    // ── Gate 4: Daily auto-trade cap ────────────────────────────────────────
    refreshDay();
    if (_tradesToday >= MAX_TRADES_PER_DAY) {
      skip(symbol, `Daily auto-trade limit reached (${_tradesToday}/${MAX_TRADES_PER_DAY})`);
      return;
    }

    // ── Gate 5: One trade per stock per day ─────────────────────────────────
    if (_tradedStocks.has(symbol)) {
      skip(symbol, 'Already auto-traded today — duplicate prevented');
      return;
    }

    // ── Gate 6: Position size (1% risk rule validation) ─────────────────────
    const positionSize = signal?.positionSize ?? 0;
    if (!Number.isInteger(positionSize) || positionSize <= 0) {
      skip(symbol, `Invalid position size: ${positionSize} — risk manager issue`);
      return;
    }

    // ── Execute ─────────────────────────────────────────────────────────────
    console.log(
      `[AutoTrader] ▶  Executing ${signal.action} ${symbol} | ` +
      `conf=${confidence}% | qty=${positionSize} | entry=₹${signal.entry ?? '?'}`
    );

    const result = await placeOrder(signal);

    if (result.status === 'SUCCESS') {
      _tradesToday++;
      _tradedStocks.add(symbol);

      console.log(
        `[AutoTrader] ✅ ${signal.action} ${symbol} placed | ` +
        `orderId=${result.orderId} | trades today: ${_tradesToday}/${MAX_TRADES_PER_DAY}`
      );

      // Fire-and-forget Telegram alert
      sendAutoTradeAlert(signal, result).catch((err) => {
        console.error(`[AutoTrader] Telegram alert failed: ${err.message}`);
      });
    } else {
      // placeOrder blocked by one of its own safety gates — log reason
      skip(symbol, result.reason || 'Blocked by orderService safety check');
    }
  } catch (err) {
    // Last-resort catch — never propagate to the pipeline
    console.error(`[AutoTrader] ❌ Unexpected error for ${signal?.symbol}: ${err.message}`);
  }
}

// ─── State inspection ─────────────────────────────────────────────────────────

/**
 * Return a snapshot of the current auto-trading state (useful for /health
 * endpoints and admin dashboards).
 * @returns {Object}
 */
function getAutoTradeState() {
  refreshDay();
  return {
    enabled:       process.env.AUTO_TRADING === 'true',
    date:          _day,
    tradesToday:   _tradesToday,
    tradedStocks:  [..._tradedStocks],
    maxPerDay:     MAX_TRADES_PER_DAY,
    minConfidence: MIN_CONFIDENCE,
  };
}

module.exports = { processSignal, getAutoTradeState };

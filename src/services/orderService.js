'use strict';

/**
 * Zerodha Order Execution Service — SAFE / MANUAL ONLY
 *
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  THIS MODULE DOES NOT AUTO-EXECUTE. It must be called       ║
 * ║  explicitly — e.g. via a manual API route or admin action.  ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Safety gates (ALL must pass before an order is placed):
 *   1. signal.confidence >= MIN_CONFIDENCE (75)
 *   2. Stock is on NSE exchange (signal.symbol matches NSE instrument list)
 *   3. positionSize > 0 (risk calculation must be valid)
 *   4. Daily trade count < MAX_DAILY_TRADES (3)
 *   5. Symbol not already traded today (no duplicates)
 *
 * Order type: MARKET / MIS (intraday) or CNC (delivery)
 *   Configurable via ORDER_PRODUCT env var (default: MIS)
 *
 * All attempts (success + failure) are logged to console and
 * kept in the in-memory ORDER_LOG (accessible via getOrderLog()).
 */

const axios = require('axios');
const { sendOrderAlert, sendOcoAlert } = require('../alerts/telegramAlert');
const { isMarketOpen, marketStatusInfo } = require('../utils/marketStatus');
const { getUniverseInstruments }         = require('./stockUniverse');

// Pre-built set of bare tickers in the Nifty universe (e.g. 'HEROMOTOCO').
// Any stock we quote is eligible for orders — we don't restrict to the
// dynamic top-20 selection, which is a ranking hint, not an order gate.
const NSE_UNIVERSE = new Set(getUniverseInstruments().map((i) => i.replace('NSE:', '')));

// ─── Constants ────────────────────────────────────────────────────────────────

const KITE_ORDERS_URL  = 'https://api.kite.trade/orders/regular';
const MIN_CONFIDENCE   = 75;   // signals below this are rejected
const MAX_DAILY_TRADES = 3;    // hard cap on orders per calendar day

// ─── In-memory state (resets on process restart — daily reset via date key) ──

const _state = {
  date:        '',   // YYYY-MM-DD of current trading day
  dailyCount:  0,    // orders placed today
  tradedToday: new Set(), // symbols already ordered today
  orderLog:    [],   // full history of all attempts this session
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return today's date as YYYY-MM-DD (IST approximation via UTC+5:30).
 * @returns {string}
 */
function todayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

/**
 * Reset daily counters when a new trading day starts.
 */
function refreshDailyState() {
  const today = todayIST();
  if (_state.date !== today) {
    _state.date        = today;
    _state.dailyCount  = 0;
    _state.tradedToday = new Set();
    console.log(`[OrderService] New trading day: ${today}. Daily counters reset.`);
  }
}

/**
 * Build Kite-authenticated request headers.
 * @returns {Object}
 */
function kiteHeaders() {
  return {
    'X-Kite-Version': '3',
    Authorization: `token ${process.env.ZERODHA_API_KEY}:${process.env.ZERODHA_ACCESS_TOKEN}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

/**
 * Append a record to the in-memory order log.
 * @param {Object} record
 */
function logOrder(record) {
  const entry = { ...record, loggedAt: new Date().toISOString() };
  _state.orderLog.unshift(entry); // newest first
  if (_state.orderLog.length > 200) _state.orderLog.pop(); // cap log size

  const status = record.status === 'SUCCESS' ? '✅' : '❌';
  console.log(
    `[OrderService] ${status} ${record.status} | ` +
    `${record.action} ${record.symbol} × ${record.quantity} @ MARKET | ` +
    (record.orderId ? `orderId=${record.orderId}` : `reason=${record.reason}`)
  );
}

/**
 * Submit a single order to Kite and return the order_id.
 * Throws on HTTP error so callers can handle individually.
 * @param {Object} params  URLSearchParams key-value pairs
 * @returns {Promise<string>} order_id
 */
async function submitKiteOrder(params) {
  const body = new URLSearchParams(params);
  const response = await axios.post(KITE_ORDERS_URL, body.toString(), {
    headers: kiteHeaders(),
    timeout: 10_000,
  });
  return response.data?.data?.order_id ?? response.data?.order_id ?? 'unknown';
}

/**
 * Place Stop Loss (SL-M) and Target (LIMIT) bracket orders after a
 * successful main order. Each leg is attempted independently so one
 * failure does not cancel the other.
 *
 * @param {string} symbol
 * @param {'BUY'|'SELL'} mainAction  The direction of the entry order
 * @param {number} quantity
 * @param {string} product           MIS | CNC
 * @param {number|null} stopLoss     Trigger price for SL-M
 * @param {number|null} target       Limit price for target order
 * @returns {Promise<{slOrderId, slError, targetOrderId, targetError}>}
 */
async function placeBracketOrders(symbol, mainAction, quantity, product, stopLoss, target) {
  const exitSide = mainAction === 'BUY' ? 'SELL' : 'BUY';
  const result   = { slOrderId: null, slError: null, targetOrderId: null, targetError: null };

  // ── Stop Loss (SL-M) ──────────────────────────────────────────────────────
  if (stopLoss != null) {
    try {
      result.slOrderId = await submitKiteOrder({
        tradingsymbol:    symbol,
        exchange:         'NSE',
        transaction_type: exitSide,
        order_type:       'SL-M',
        trigger_price:    String(stopLoss),
        quantity:         String(quantity),
        product,
        validity:         'DAY',
      });
      console.log(`[OrderService] ✅ SL order placed: ${symbol} ${exitSide} SL-M @₹${stopLoss} | orderId=${result.slOrderId}`);
    } catch (err) {
      result.slError = err.response?.data?.message || err.message;
      console.error(`[OrderService] ❌ SL order failed: ${symbol} — ${result.slError}`);
    }
  }

  // ── Target (LIMIT) ────────────────────────────────────────────────────────
  if (target != null) {
    try {
      result.targetOrderId = await submitKiteOrder({
        tradingsymbol:    symbol,
        exchange:         'NSE',
        transaction_type: exitSide,
        order_type:       'LIMIT',
        price:            String(target),
        quantity:         String(quantity),
        product,
        validity:         'DAY',
      });
      console.log(`[OrderService] ✅ Target order placed: ${symbol} ${exitSide} LIMIT @₹${target} | orderId=${result.targetOrderId}`);
    } catch (err) {
      result.targetError = err.response?.data?.message || err.message;
      console.error(`[OrderService] ❌ Target order failed: ${symbol} — ${result.targetError}`);
    }
  }

  return result;
}

// ─── Safety gates ─────────────────────────────────────────────────────────────

/**
 * Run all pre-order safety checks.
 * @param {Object} signal
 * @returns {{ ok: boolean, reason?: string }}
 */
function runSafetyChecks(signal) {
  // 0. Market session — must be within NSE trading hours
  if (!isMarketOpen()) {
    const { reason } = marketStatusInfo();
    return { ok: false, reason: `Market is closed. ${reason}` };
  }

  // 1. Credentials present
  if (!process.env.ZERODHA_API_KEY || !process.env.ZERODHA_ACCESS_TOKEN) {
    return { ok: false, reason: 'Zerodha credentials not configured' };
  }

  // 2. Confidence threshold
  const confidence = signal.confidence ?? 0;
  if (confidence < MIN_CONFIDENCE) {
    return {
      ok: false,
      reason: `Signal confidence ${confidence}% is below minimum ${MIN_CONFIDENCE}%`,
    };
  }

  // 3. NSE-only symbols — must be in the tracked NSE universe
  const symbol = (signal.symbol || '').toUpperCase().replace(/^NSE:/, '');
  if (!NSE_UNIVERSE.has(symbol)) {
    return {
      ok: false,
      reason: `Symbol ${symbol} is not in the NSE universe`,
    };
  }

  // 4. Valid position size
  const quantity = signal.positionSize ?? 0;
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return {
      ok: false,
      reason: `Invalid position size: ${quantity} — check risk manager output`,
    };
  }

  // 5. Daily trade cap
  refreshDailyState();
  if (_state.dailyCount >= MAX_DAILY_TRADES) {
    return {
      ok: false,
      reason: `Daily trade limit reached (${MAX_DAILY_TRADES} trades). No more orders today.`,
    };
  }

  // 6. Duplicate prevention
  if (_state.tradedToday.has(symbol)) {
    return {
      ok: false,
      reason: `${symbol} already traded today. Duplicate orders are blocked.`,
    };
  }

  return { ok: true };
}

// ─── Core order function ──────────────────────────────────────────────────────

/**
 * Place a MARKET order on Zerodha Kite for the given signal.
 *
 * THIS FUNCTION MUST BE CALLED MANUALLY — it is NOT triggered automatically.
 *
 * @param {Object}  signal
 * @param {string}  signal.symbol          NSE ticker (e.g. "RELIANCE")
 * @param {string}  signal.action          "BUY" or "SELL"
 * @param {number}  signal.confidence      0–100 confidence score
 * @param {number}  signal.positionSize    Shares to trade (from riskManager)
 * @param {number}  signal.entry           Entry price (for logging)
 * @param {number}  signal.stopLoss        Stop-loss price (for logging)
 * @param {number}  signal.target          Target price (for logging)
 * @returns {Promise<Object>}  Result object with status, orderId or reason
 */
async function placeOrder(signal) {
  const symbol   = (signal.symbol || '').toUpperCase().replace(/^NSE:/, '');
  const action   = (signal.action  || '').toUpperCase();
  const quantity = signal.positionSize ?? 0;
  const product  = (process.env.ORDER_PRODUCT || 'MIS').toUpperCase(); // MIS or CNC

  const baseLog = {
    symbol,
    action,
    quantity,
    product,
    confidence:  signal.confidence,
    entry:       signal.entry,
    stopLoss:    signal.stopLoss,
    target:      signal.target,
    rrRatio:     signal.rrRatio,
    riskAmount:  signal.riskAmount,
  };

  // ── Safety checks ──────────────────────────────────────────────────────────
  const check = runSafetyChecks(signal);
  if (!check.ok) {
    logOrder({ ...baseLog, status: 'REJECTED', reason: check.reason });
    return { status: 'REJECTED', reason: check.reason };
  }

  // ── Place main entry order (MARKET) ───────────────────────────────────────
  try {
    console.log(
      `[OrderService] Placing ${action} MARKET order: ${symbol} × ${quantity} (${product}) | ` +
      `conf=${signal.confidence}% | entry=₹${signal.entry} sl=₹${signal.stopLoss} target=₹${signal.target}`
    );

    const entryOrderId = await submitKiteOrder({
      tradingsymbol:    symbol,
      exchange:         'NSE',
      transaction_type: action,
      order_type:       'MARKET',
      quantity:         String(quantity),
      product,
      validity:         'DAY',
    });

    // Update daily state
    _state.dailyCount += 1;
    _state.tradedToday.add(symbol);
    console.log(`[OrderService] ✅ Entry order placed: ${symbol} ${action} MARKET | orderId=${entryOrderId}`);

    // ── Place bracket orders (SL + Target) ───────────────────────────────────
    const bracket = await placeBracketOrders(
      symbol, action, quantity, product,
      signal.stopLoss ?? null,
      signal.target   ?? null,
    );

    const result = {
      status:        'SUCCESS',
      orderId:        entryOrderId,
      slOrderId:      bracket.slOrderId,
      slError:        bracket.slError,
      targetOrderId:  bracket.targetOrderId,
      targetError:    bracket.targetError,
      symbol,
      action,
      quantity,
      product,
      confidence:    signal.confidence,
      entry:         signal.entry,
      stopLoss:      signal.stopLoss,
      target:        signal.target,
    };

    logOrder({ ...baseLog, status: 'SUCCESS', orderId: entryOrderId, ...bracket });
    sendOrderAlert(result, signal).catch(() => {});

    // Register for OCO monitoring if both bracket legs were placed
    registerOcoTrade({
      symbol:        symbol,
      action:        action,
      quantity:      quantity,
      entry:         signal.entry,
      stopLoss:      signal.stopLoss,
      target:        signal.target,
      entryOrderId:  entryOrderId,
      slOrderId:     bracket.slOrderId,
      targetOrderId: bracket.targetOrderId,
    });

    return result;

  } catch (err) {
    const kiteMessage =
      err.response?.data?.message ||
      err.response?.data?.error_type ||
      err.message;

    const failedResult = { status: 'FAILED', reason: kiteMessage, symbol, action };
    logOrder({ ...baseLog, status: 'FAILED', reason: kiteMessage });
    sendOrderAlert(failedResult, signal).catch(() => {});
    return failedResult;
  }
}

// ─── Accessors ────────────────────────────────────────────────────────────────

/**
 * Return a snapshot of today's order state (for dashboards / API routes).
 * @returns {{ date: string, dailyCount: number, tradedToday: string[], remaining: number }}
 */
function getDailyState() {
  refreshDailyState();
  return {
    date:        _state.date,
    dailyCount:  _state.dailyCount,
    tradedToday: [..._state.tradedToday],
    remaining:   MAX_DAILY_TRADES - _state.dailyCount,
    maxTrades:   MAX_DAILY_TRADES,
  };
}

/**
 * Return the full in-memory order log (newest first).
 * @returns {Array<Object>}
 */
function getOrderLog() {
  return _state.orderLog;
}

// ─── OCO (One Cancels Other) ──────────────────────────────────────────────────

/**
 * In-memory registry of active OCO trades.
 * Each entry: { symbol, action, entry, stopLoss, target, quantity,
 *               entryOrderId, slOrderId, targetOrderId, done }
 * @type {Map<string, Object>}
 */
const _ocoTrades = new Map();

/**
 * Register a successfully placed bracket trade for OCO monitoring.
 * Called internally after placeOrder() succeeds with bracket orders.
 * @param {Object} params
 */
function registerOcoTrade(params) {
  const { entryOrderId, slOrderId, targetOrderId } = params;
  // Only register if both bracket legs were placed
  if (!slOrderId || !targetOrderId) return;

  const key = entryOrderId;
  _ocoTrades.set(key, {
    ...params,
    done: false,
    registeredAt: new Date().toISOString(),
  });
  console.log(`[OCO] Registered trade ${params.symbol} | entry=${entryOrderId} sl=${slOrderId} target=${targetOrderId}`);
}

/**
 * Fetch all orders from Kite and return them as a Map keyed by order_id.
 * @returns {Promise<Map<string, Object>>}
 */
async function fetchKiteOrders() {
  const res = await axios.get('https://api.kite.trade/orders', {
    headers: kiteHeaders(),
    timeout: 10_000,
  });
  const list = res.data?.data ?? [];
  const map  = new Map();
  for (const o of list) {
    if (o.order_id) map.set(String(o.order_id), o);
  }
  return map;
}

/**
 * Cancel a single Kite order by order_id.
 * @param {string} orderId
 * @returns {Promise<void>}
 */
async function cancelKiteOrder(orderId) {
  await axios.delete(`https://api.kite.trade/orders/regular/${orderId}`, {
    headers: kiteHeaders(),
    timeout: 10_000,
  });
  console.log(`[OCO] Cancelled order ${orderId}`);
}

/**
 * Monitor all active OCO trades. For each trade:
 *   - If target leg is COMPLETE → cancel SL leg, send Telegram alert
 *   - If SL leg is COMPLETE     → cancel target leg, send Telegram alert
 *
 * Runs on a cron every 5 seconds. Skips gracefully on API errors.
 */
async function monitorOrders() {
  if (_ocoTrades.size === 0) return; // nothing to monitor

  let kiteOrders;
  try {
    kiteOrders = await fetchKiteOrders();
  } catch (err) {
    console.error(`[OCO] Could not fetch orders from Kite: ${err.message}`);
    return;
  }

  for (const [key, trade] of _ocoTrades) {
    if (trade.done) continue;

    const slOrder     = kiteOrders.get(String(trade.slOrderId));
    const targetOrder = kiteOrders.get(String(trade.targetOrderId));

    const slStatus     = slOrder?.status     ?? 'UNKNOWN';
    const targetStatus = targetOrder?.status ?? 'UNKNOWN';

    // Target hit → cancel SL
    if (targetStatus === 'COMPLETE') {
      console.log(`[OCO] 🎯 Target COMPLETE for ${trade.symbol}. Cancelling SL order ${trade.slOrderId}.`);
      trade.done = true;
      try {
        if (slStatus !== 'COMPLETE' && slStatus !== 'CANCELLED' && slStatus !== 'REJECTED') {
          await cancelKiteOrder(trade.slOrderId);
        }
        sendOcoAlert('target', trade).catch(() => {});
      } catch (err) {
        console.error(`[OCO] Failed to cancel SL order ${trade.slOrderId}: ${err.message}`);
      }
      continue;
    }

    // SL hit → cancel target
    if (slStatus === 'COMPLETE') {
      console.log(`[OCO] 🛑 Stop Loss COMPLETE for ${trade.symbol}. Cancelling target order ${trade.targetOrderId}.`);
      trade.done = true;
      try {
        if (targetStatus !== 'COMPLETE' && targetStatus !== 'CANCELLED' && targetStatus !== 'REJECTED') {
          await cancelKiteOrder(trade.targetOrderId);
        }
        sendOcoAlert('sl', trade).catch(() => {});
      } catch (err) {
        console.error(`[OCO] Failed to cancel target order ${trade.targetOrderId}: ${err.message}`);
      }
      continue;
    }

    // Both cancelled/rejected externally — remove from registry
    const bothGone = ['CANCELLED', 'REJECTED'].includes(slStatus) &&
                     ['CANCELLED', 'REJECTED'].includes(targetStatus);
    if (bothGone) {
      console.log(`[OCO] Trade ${trade.symbol} bracket orders both gone (${slStatus}/${targetStatus}). Removing.`);
      trade.done = true;
    }
  }

  // Purge completed trades to keep map tidy (keep last 50)
  for (const [key, trade] of _ocoTrades) {
    if (trade.done) _ocoTrades.delete(key);
  }
}

/**
 * Return a snapshot of currently monitored OCO trades.
 */
function getOcoTrades() {
  return [..._ocoTrades.values()];
}

// ─── Exports ──────────────────────────────────────────────────────────────────
// placeOrder is NOT wired to any cron or auto-pipeline.
// Import and call it explicitly from an API route or admin action.

module.exports = { placeOrder, getDailyState, getOrderLog, monitorOrders, getOcoTrades };

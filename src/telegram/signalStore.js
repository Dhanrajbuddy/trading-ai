'use strict';

/**
 * Signal Store — Persistent storage for paid-signal records and payment records.
 *
 * Uses the same JSON-file persistence pattern as signalTracker.js.
 * Data file: data/paid-signals.json
 *
 * Two collections:
 *   signals[]   — one entry per generated signal (preview posted to channel)
 *   payments[]  — one entry per successful Stars payment
 *
 * Idempotency: payment records are keyed by telegram_payment_charge_id.
 * Duplicate successful_payment updates with the same charge ID are ignored.
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR  = fs.existsSync('/app/data') ? '/app/data' : path.join(__dirname, '../../data');
const DATA_FILE = path.join(DATA_DIR, 'paid-signals.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadFromDisk() {
  try {
    ensureDataDir();
    if (!fs.existsSync(DATA_FILE)) return { signals: [], payments: [] };
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (_) {
    return { signals: [], payments: [] };
  }
}

function saveToDisk() {
  try {
    ensureDataDir();
    fs.writeFileSync(DATA_FILE, JSON.stringify(_store, null, 2), 'utf8');
  } catch (err) {
    console.error(`[SignalStore] Failed to persist: ${err.message}`);
  }
}

const _store = loadFromDisk();

// ─── Signal records ──────────────────────────────────────────────────────────

/**
 * Create a new signal record and return its ID.
 * @param {Object} signal      Full signal object from signalEngine
 * @param {Object} analysis    AI analysis from aiAnalyzer
 * @param {number} priceStars  Configured Stars price
 * @returns {string} signal_id
 */
function createSignalRecord(signal, analysis, priceStars) {
  const signalId = crypto.randomUUID();

  _store.signals.push({
    signal_id:        signalId,
    symbol:           signal.symbol,
    action:           signal.action,
    confidence:       signal.confidence,
    created_at:       new Date().toISOString(),
    price_stars:      priceStars,
    channel_message_id: null,
    full_signal_payload: JSON.stringify({ signal, analysis }),
    payment_status:   'pending',
  });

  if (_store.signals.length > 500) _store.signals.shift();
  saveToDisk();

  console.log(`[SignalStore] signal_created signal_id=${signalId} symbol=${signal.symbol}`);
  return signalId;
}

/**
 * Get a signal record by ID.
 * @param {string} signalId
 * @returns {Object|null}
 */
function getSignal(signalId) {
  return _store.signals.find((s) => s.signal_id === signalId) || null;
}

/**
 * Update the channel message ID for a signal (after posting preview).
 * @param {string} signalId
 * @param {number} messageId
 */
function setChannelMessageId(signalId, messageId) {
  const sig = getSignal(signalId);
  if (sig) {
    sig.channel_message_id = messageId;
    saveToDisk();
  }
}

/**
 * Get the full signal payload (signal + analysis) for a signal ID.
 * @param {string} signalId
 * @returns {{ signal: Object, analysis: Object }|null}
 */
function getFullSignal(signalId) {
  const sig = getSignal(signalId);
  if (!sig) return null;
  try {
    return JSON.parse(sig.full_signal_payload);
  } catch (_) {
    return null;
  }
}

// ─── Payment records ─────────────────────────────────────────────────────────

/**
 * Check if a user has already purchased a signal.
 * @param {string} signalId
 * @param {number} telegramUserId
 * @returns {boolean}
 */
function hasPurchased(signalId, telegramUserId) {
  return _store.payments.some(
    (p) => p.signal_id === signalId && p.telegram_user_id === telegramUserId && p.status === 'successful'
  );
}

/**
 * Record a successful payment. Idempotent by telegram_payment_charge_id.
 * @param {Object} payment
 * @param {string} payment.signal_id
 * @param {number} payment.telegram_user_id
 * @param {string} payment.telegram_username
 * @param {string} payment.telegram_payment_charge_id
 * @param {number} payment.stars_amount
 * @param {string} payment.currency
 * @returns {{ created: boolean, duplicate: boolean }}
 */
function recordPayment(payment) {
  // Idempotency: check by charge ID
  const existing = _store.payments.find(
    (p) => p.telegram_payment_charge_id === payment.telegram_payment_charge_id
  );
  if (existing) {
    console.log(`[SignalStore] Duplicate payment ignored charge_id=${payment.telegram_payment_charge_id}`);
    return { created: false, duplicate: true };
  }

  _store.payments.push({
    payment_id:                  crypto.randomUUID(),
    signal_id:                   payment.signal_id,
    telegram_user_id:            payment.telegram_user_id,
    telegram_username:           payment.telegram_username || '',
    telegram_payment_charge_id:  payment.telegram_payment_charge_id,
    stars_amount:                payment.stars_amount,
    currency:                    payment.currency,
    status:                      'successful',
    created_at:                  new Date().toISOString(),
  });

  if (_store.payments.length > 1000) _store.payments.shift();
  saveToDisk();

  console.log(
    `[SignalStore] payment_success signal_id=${payment.signal_id} ` +
    `user_id=${payment.telegram_user_id} stars=${payment.stars_amount}`
  );
  return { created: true, duplicate: false };
}

/**
 * Get all payments for a specific signal (for analytics).
 * @param {string} signalId
 * @returns {Array}
 */
function getPaymentsForSignal(signalId) {
  return _store.payments.filter((p) => p.signal_id === signalId);
}

module.exports = {
  createSignalRecord,
  getSignal,
  setChannelMessageId,
  getFullSignal,
  hasPurchased,
  recordPayment,
  getPaymentsForSignal,
};

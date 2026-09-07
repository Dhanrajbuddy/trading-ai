'use strict';

/**
 * Payment Service — Telegram Stars payment logic.
 *
 * Handles:
 *   - Creating Stars invoices (currency=XTR)
 *   - Verifying successful_payment updates from Telegram
 *   - Recording payments in signalStore (idempotent)
 *   - Delivering full signal after verified payment
 *
 * Security: Only trusts Telegram's successful_payment event.
 * Validates currency (XTR), amount (matches configured price),
 * and signal existence before recording.
 */

const { getSignal, getFullSignal, hasPurchased, recordPayment } = require('./signalStore');
const { formatFullSignal } = require('./previewFormatter');

const PRICE_STARS  = parseInt(process.env.TELEGRAM_SIGNAL_PRICE_STARS || '200', 10);
const CURRENCY     = process.env.TELEGRAM_PAYMENT_CURRENCY || 'XTR';

/**
 * Build the invoice payload for a Telegram Stars payment.
 * @param {string} signalId
 * @returns {{ title: string, description: string, payload: string, currency: string, prices: Array }}
 */
function buildInvoice(signalId) {
  const sig = getSignal(signalId);
  if (!sig) throw new Error(`Signal not found: ${signalId}`);

  return {
    title:          `${sig.action} Signal — ${sig.symbol}`,
    description:    `Unlock full trading signal: entry, stop loss, target, and complete AI reasoning. AI confidence: ${sig.confidence}%.`,
    payload:        `unlock_signal:${signalId}`,
    currency:       CURRENCY,
    prices:         [{ label: 'Signal Unlock', amount: PRICE_STARS }],
    provider_token: '',  // empty for Stars (digital goods)
  };
}

/**
 * Verify a successful_payment update from Telegram.
 *
 * Checks:
 *   - currency is XTR
 *   - amount matches configured price
 *   - signal exists
 *   - payload contains a valid signal_id
 *
 * @param {Object} successfulPayment  Telegram successful_payment object
 * @returns {{ valid: boolean, signalId: string|null, error: string|null }}
 */
function verifyPayment(successfulPayment) {
  if (!successfulPayment || !successfulPayment.invoice_payload) {
    return { valid: false, signalId: null, error: 'Missing payment data' };
  }

  const payload = successfulPayment.invoice_payload;
  if (!payload.startsWith('unlock_signal:')) {
    return { valid: false, signalId: null, error: 'Unexpected payload' };
  }

  const signalId = payload.substring('unlock_signal:'.length);
  const sig = getSignal(signalId);
  if (!sig) {
    return { valid: false, signalId, error: 'Signal not found' };
  }

  if (successfulPayment.currency !== CURRENCY) {
    return { valid: false, signalId, error: `Wrong currency: ${successfulPayment.currency} expected ${CURRENCY}` };
  }

  if (successfulPayment.total_amount !== PRICE_STARS) {
    return { valid: false, signalId, error: `Wrong amount: ${successfulPayment.total_amount} expected ${PRICE_STARS}` };
  }

  return { valid: true, signalId, error: null };
}

/**
 * Process a verified successful payment.
 * Records the payment (idempotent) and delivers the full signal to the user.
 *
 * @param {Object} successfulPayment  Telegram successful_payment object
 * @param {number} telegramUserId
 * @param {string} telegramUsername
 * @param {Function} sendFn  async (chatId, text, options) => Promise  — delivery function
 * @returns {{ delivered: boolean, duplicate: boolean, error: string|null }}
 */
async function processSuccessfulPayment(successfulPayment, telegramUserId, telegramUsername, sendFn) {
  const { valid, signalId, error } = verifyPayment(successfulPayment);
  if (!valid) {
    console.log(`[PaymentService] Payment verification failed: ${error}`);
    return { delivered: false, duplicate: false, error };
  }

  // Check if already purchased — return signal without re-charging
  if (hasPurchased(signalId, telegramUserId)) {
    console.log(`[PaymentService] signal_unlocked (already purchased) signal_id=${signalId} user_id=${telegramUserId}`);
    const full = getFullSignal(signalId);
    if (full) {
      const text = formatFullSignal(full.signal, full.analysis);
      await sendFn(telegramUserId, text, { parse_mode: 'Markdown' });
    }
    return { delivered: true, duplicate: true, error: null };
  }

  // Record payment (idempotent by charge ID)
  const result = recordPayment({
    signal_id:                  signalId,
    telegram_user_id:           telegramUserId,
    telegram_username:          telegramUsername,
    telegram_payment_charge_id: successfulPayment.telegram_payment_charge_id,
    stars_amount:               successfulPayment.total_amount,
    currency:                   successfulPayment.currency,
  });

  if (result.duplicate) {
    // Already processed — deliver signal (safe retry)
    const full = getFullSignal(signalId);
    if (full) {
      const text = formatFullSignal(full.signal, full.analysis);
      await sendFn(telegramUserId, text, { parse_mode: 'Markdown' });
    }
    return { delivered: true, duplicate: true, error: null };
  }

  // Deliver full signal
  const full = getFullSignal(signalId);
  if (!full) {
    console.error(`[PaymentService] Signal payload missing for signal_id=${signalId}`);
    return { delivered: false, duplicate: false, error: 'Signal data not found' };
  }

  const text = formatFullSignal(full.signal, full.analysis);
  try {
    await sendFn(telegramUserId, text, { parse_mode: 'Markdown' });
    console.log(`[PaymentService] signal_unlocked signal_id=${signalId} user_id=${telegramUserId}`);
    return { delivered: true, duplicate: false, error: null };
  } catch (err) {
    // Payment succeeded but delivery failed — payment is still recorded
    console.error(`[PaymentService] Delivery failed (payment recorded): ${err.message}`);
    return { delivered: false, duplicate: false, error: `Delivery failed: ${err.message}` };
  }
}

module.exports = {
  PRICE_STARS,
  CURRENCY,
  buildInvoice,
  verifyPayment,
  processSuccessfulPayment,
};

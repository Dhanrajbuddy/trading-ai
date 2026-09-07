'use strict';

/**
 * Telegram Bot — Polling-based bot that handles:
 *   - callback_query from "Unlock" button clicks
 *   - pre_checkout_query (auto-approve for digital goods)
 *   - successful_payment (verify + record + deliver full signal)
 *   - /start deep-link onboarding
 *
 * This bot runs with polling: true so it can receive updates.
 * The existing send-only bot in telegramAlert.js is separate and
 * remains unchanged for non-signal alerts (market open/close, OCO, etc.).
 */

const TelegramBot = require('node-telegram-bot-api');
const { getSignal, hasPurchased, getFullSignal } = require('./signalStore');
const { buildInvoice, processSuccessfulPayment, PRICE_STARS } = require('./paymentService');
const { formatFullSignal } = require('./previewFormatter');

let _bot = null;
let _started = false;

/**
 * Get or create the polling bot instance.
 * @returns {TelegramBot|null}
 */
function getBot() {
  if (!_bot && process.env.TELEGRAM_TOKEN) {
    _bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
  }
  return _bot;
}

/**
 * Start the bot and register all handlers.
 * Called once from index.js on startup.
 */
function startBot() {
  const bot = getBot();
  if (!bot) {
    console.log('[TelegramBot] No TELEGRAM_TOKEN — bot not started.');
    return;
  }
  if (_started) return;
  _started = true;

  // ── /start handler (onboarding + deep-link) ──────────────────────────────
  bot.onText(/^\/start(.*)$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const param  = match[1].trim();

    if (param.startsWith('signal_')) {
      const signalId = param.substring('signal_'.length);
      await handleUnlockRequest(chatId, msg.from, signalId);
      return;
    }

    // Generic /start
    await bot.sendMessage(
      chatId,
      '👋 Welcome to the AI Trading Signal Channel!\n\n' +
      'I deliver premium trading signals with AI-powered analysis.\n\n' +
      'To unlock signals, use the 🔓 button on any signal post in the channel.\n\n' +
      `Each signal costs ${PRICE_STARS} ⭐ Stars.`
    );
  });

  // ── callback_query handler (Unlock button) ───────────────────────────────
  bot.on('callback_query', async (query) => {
    const data = query.data;
    if (!data || !data.startsWith('unlock_signal:')) {
      // Not our callback — acknowledge silently
      try { await bot.answerCallbackQuery(query.id); } catch (_) {}
      return;
    }

    const signalId = data.substring('unlock_signal:'.length);
    const userId   = query.from.id;
    const chatId   = query.message?.chat?.id || userId;

    try {
      await bot.answerCallbackQuery(query.id);
    } catch (_) {}

    await handleUnlockRequest(chatId, query.from, signalId);
  });

  // ── pre_checkout_query (auto-approve for digital goods) ──────────────────
  bot.on('pre_checkout_query', async (query) => {
    try {
      await bot.answerPreCheckoutQuery(query.id, true);
    } catch (err) {
      console.error(`[TelegramBot] Pre-checkout answer failed: ${err.message}`);
    }
  });

  // ── successful_payment (the ONLY trigger for unlocking) ──────────────────
  bot.on('successful_payment', async (msg) => {
    const payment = msg.successful_payment;
    const user    = msg.from;

    console.log(
      `[TelegramBot] payment_started signal_id=unknown ` +
      `user_id=${user.id} charge=${payment.telegram_payment_charge_id}`
    );

    const sendFn = async (chatId, text, options) => {
      await bot.sendMessage(chatId, text, options);
    };

    const result = await processSuccessfulPayment(
      payment,
      user.id,
      user.username || '',
      sendFn
    );

    if (result.delivered && !result.duplicate) {
      await bot.sendMessage(
        user.id,
        '⭐ *Payment successful*\n\n🔓 Signal unlocked — see full details below.',
        { parse_mode: 'Markdown' }
      );
    } else if (result.delivered && result.duplicate) {
      await bot.sendMessage(
        user.id,
        '✅ You already purchased this signal. Here it is again:',
        { parse_mode: 'Markdown' }
      );
    } else if (result.error) {
      await bot.sendMessage(
        user.id,
        `❌ Payment processed but delivery failed: ${result.error}\nPlease contact support.`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  // ── polling error handler ────────────────────────────────────────────────
  bot.on('polling_error', (err) => {
    console.error(`[TelegramBot] Polling error: ${err.message}`);
  });

  console.log('[TelegramBot] ✅ Bot started with polling — listening for payments & unlocks.');
}

/**
 * Handle an unlock request (from callback button or /start deep-link).
 * Checks if already purchased → deliver immediately.
 * Otherwise → send Stars invoice.
 *
 * @param {number} chatId     Telegram chat ID to send response to
 * @param {Object} fromUser   Telegram user object { id, username, first_name }
 * @param {string} signalId   Signal UUID
 */
async function handleUnlockRequest(chatId, fromUser, signalId) {
  const sig = getSignal(signalId);
  if (!sig) {
    await _bot.sendMessage(chatId, '❌ Signal not found or expired.');
    return;
  }

  // Already purchased? Deliver without re-charging
  if (hasPurchased(signalId, fromUser.id)) {
    const full = getFullSignal(signalId);
    if (full) {
      const text = formatFullSignal(full.signal, full.analysis);
      await _bot.sendMessage(chatId, '✅ You already own this signal:', { parse_mode: 'Markdown' });
      await _bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } else {
      await _bot.sendMessage(chatId, '❌ Signal data not available.');
    }
    return;
  }

  // Send Stars invoice
  try {
    const invoice = buildInvoice(signalId);
    await _bot.sendInvoice(
      chatId,
      invoice.title,
      invoice.description,
      invoice.payload,
      invoice.provider_token,
      invoice.currency,
      invoice.prices
    );
    console.log(`[TelegramBot] Invoice sent signal_id=${signalId} user_id=${fromUser.id}`);
  } catch (err) {
    console.error(`[TelegramBot] Failed to send invoice: ${err.message}`);
    await _bot.sendMessage(chatId, '❌ Could not create payment invoice. Please try again.');
  }
}

/**
 * Get the bot instance (for use by signal publisher to send channel messages).
 * @returns {TelegramBot|null}
 */
function getBotInstance() {
  return getBot();
}

module.exports = { startBot, getBotInstance };

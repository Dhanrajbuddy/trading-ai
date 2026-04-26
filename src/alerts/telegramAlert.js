'use strict';

/**
 * Telegram Alert Module
 * Sends formatted BUY/SELL signal notifications via Telegram Bot API
 */

const TelegramBot = require('node-telegram-bot-api');

let bot = null;

function getBot() {
  if (!bot && process.env.TELEGRAM_TOKEN) {
    bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false });
  }
  return bot;
}

/**
 * Format a signal + AI analysis into a Telegram message
 * @param {Object} signal
 * @param {Object} analysis
 * @returns {string}
 */
function formatMessage(signal, analysis) {
  const emoji    = signal.action === 'BUY' ? '🟢' : '🔴';
  const confBar  = '█'.repeat(Math.floor(analysis.confidence / 10)) + '░'.repeat(10 - Math.floor(analysis.confidence / 10));

  return (
    `${emoji} *${signal.action} SIGNAL — ${signal.symbol}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💵 Price:       *₹${signal.price}*\n` +
    `📈 Change:      *${signal.changePercent > 0 ? '+' : ''}${signal.changePercent}%*\n` +
    `📊 Volume:      ${signal.volume.toLocaleString()}\n` +
    `📉 Avg Volume:  ${signal.avgVolume.toLocaleString()}\n` +
    `⚡ Vol Mult:    ${signal.volumeMultiplier.toFixed(1)}x\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🧠 AI Confidence: *${analysis.confidence}%*\n` +
    `${confBar}\n` +
    `💬 _${analysis.reasoning}_\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📋 Reasons:\n${signal.reasons.map((r) => `  • ${r}`).join('\n')}\n` +
    `⏰ ${new Date(signal.timestamp).toUTCString()}`
  );
}

/**
 * Send a trading signal alert to the configured Telegram chat
 * @param {Object} signal
 * @param {Object} analysis
 * @returns {Promise<void>}
 */
async function sendAlert(signal, analysis) {
  const instance = getBot();
  const chatId   = process.env.CHAT_ID;

  if (!instance || !chatId) {
    console.log(`[Telegram] Not configured — skipping alert for ${signal.symbol}`);
    return;
  }

  try {
    const text = formatMessage(signal, analysis);
    await instance.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    console.log(`[Telegram] Alert sent for ${signal.symbol} (${signal.action})`);
  } catch (err) {
    console.error(`[Telegram] Failed to send alert: ${err.message}`);
  }
}

/**
 * Format an order execution result into a Telegram message.
 * @param {Object} result  — placeOrder() return value
 * @param {Object} signal  — original signal passed to placeOrder()
 * @returns {string}
 */
function formatOrderMessage(result, signal) {
  if (result.status === 'SUCCESS') {
    const entry  = signal.entry    != null ? `₹${signal.entry}`    : '—';
    const sl     = signal.stopLoss != null ? `₹${signal.stopLoss}` : (signal.sl != null ? `₹${signal.sl}` : '—');
    const target = signal.target   != null ? `₹${signal.target}`   : '—';
    const qty    = result.quantity  ?? signal.positionSize ?? '—';
    const sym    = result.symbol    ?? signal.symbol ?? '—';
    const act    = result.action    ?? signal.action ?? '—';

    const entryLine  = `${result.orderId       ? '✔' : '✘'} Entry placed${result.orderId       ? ` (\`${result.orderId}\`)`       : ''}`;
    const slLine     = result.slOrderId
      ? `✔ Stop Loss placed (\`${result.slOrderId}\`)`
      : `✘ Stop Loss failed — _${result.slError ?? 'not set'}_`;
    const targetLine = result.targetOrderId
      ? `✔ Target placed (\`${result.targetOrderId}\`)`
      : `✘ Target failed — _${result.targetError ?? 'not set'}_`;

    return (
      `🚀 *TRADE EXECUTED*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📌 Stock:   *${sym}*\n` +
      `📋 Type:    *${act}*\n` +
      `💵 Entry:   ${entry}\n` +
      `🛑 SL:      ${sl}\n` +
      `🎯 Target:  ${target}\n` +
      `🔢 Qty:     ${qty}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `Orders:\n` +
      `${entryLine}\n` +
      `${slLine}\n` +
      `${targetLine}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `Status: *SUCCESS* ✅`
    );
  }

  // REJECTED or FAILED
  const reason = result.reason || result.message || 'Unknown error';
  return (
    `❌ *TRADE FAILED*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📌 Stock:  *${signal.symbol ?? '—'}*\n` +
    `📋 Type:   *${signal.action ?? '—'}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Reason: _${reason}_`
  );
}

/**
 * Send a Telegram notification about an order execution result.
 * @param {Object} result  — placeOrder() return value
 * @param {Object} signal  — original signal passed to placeOrder()
 * @returns {Promise<void>}
 */
async function sendOrderAlert(result, signal) {
  const instance = getBot();
  const chatId   = process.env.CHAT_ID;

  if (!instance || !chatId) {
    console.log(`[Telegram] Not configured — skipping order alert for ${signal.symbol}`);
    return;
  }

  try {
    const text = formatOrderMessage(result, signal);
    await instance.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    console.log(`[Telegram] Order alert sent for ${signal.symbol} (${result.status})`);
  } catch (err) {
    console.error(`[Telegram] Failed to send order alert: ${err.message}`);
  }
}

/**
 * Send a market open/close Telegram notification.
 * @param {'open'|'close'} event
 * @returns {Promise<void>}
 */
async function sendMarketAlert(event) {
  const instance = getBot();
  const chatId   = process.env.CHAT_ID;

  if (!instance || !chatId) {
    console.log(`[Telegram] Not configured — skipping market ${event} alert`);
    return;
  }

  const text = event === 'open'
    ? `📈 *Market Open*\n━━━━━━━━━━━━━━━━━━━━\nTrading session has started.\nNSE regular hours: 09:15 – 15:30 IST`
    : `📉 *Market Closed*\n━━━━━━━━━━━━━━━━━━━━\nTrading session has ended.\nNo trades will be executed until 09:15 IST tomorrow.`;

  try {
    await instance.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    console.log(`[Telegram] Market ${event} alert sent.`);
  } catch (err) {
    console.error(`[Telegram] Failed to send market alert: ${err.message}`);
  }
}

/**
 * Send a Telegram alert when an OCO leg completes (target hit or SL hit).
 * @param {'target'|'sl'} event
 * @param {Object} trade  — OCO trade record { symbol, action, entry, stopLoss, target, quantity }
 * @returns {Promise<void>}
 */
async function sendOcoAlert(event, trade) {
  const instance = getBot();
  const chatId   = process.env.CHAT_ID;

  if (!instance || !chatId) return;

  const sym = trade.symbol ?? '—';
  const qty = trade.quantity ?? '—';

  const text = event === 'target'
    ? (
      `🎯 *TARGET HIT*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📌 Stock:   *${sym}*\n` +
      `🔢 Qty:     ${qty}\n` +
      `💵 Entry:   ₹${trade.entry ?? '—'}\n` +
      `🎯 Target:  ₹${trade.target ?? '—'}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `✅ *Profit booked!* Stop Loss order cancelled.`
    )
    : (
      `🛑 *STOP LOSS HIT*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📌 Stock:   *${sym}*\n` +
      `🔢 Qty:     ${qty}\n` +
      `💵 Entry:   ₹${trade.entry ?? '—'}\n` +
      `🛑 SL:      ₹${trade.stopLoss ?? '—'}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🔒 *Loss controlled.* Target order cancelled.`
    );

  try {
    await instance.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    console.log(`[Telegram] OCO ${event} alert sent for ${sym}.`);
  } catch (err) {
    console.error(`[Telegram] Failed to send OCO alert: ${err.message}`);
  }
}

/**
 * Send a Telegram alert when auto-trading executes a trade.
 * @param {Object} signal  original signal
 * @param {Object} result  placeOrder() return value
 * @returns {Promise<void>}
 */
async function sendAutoTradeAlert(signal, result) {
  const instance = getBot();
  const chatId   = process.env.CHAT_ID;

  if (!instance || !chatId) return;

  const sym    = result.symbol   ?? signal.symbol   ?? '—';
  const act    = result.action   ?? signal.action   ?? '—';
  const entry  = signal.entry    != null ? `₹${signal.entry}`    : '—';
  const sl     = signal.stopLoss != null ? `₹${signal.stopLoss}` : '—';
  const target = signal.target   != null ? `₹${signal.target}`   : '—';
  const qty    = result.quantity  ?? signal.positionSize ?? '—';
  const conf   = signal.confidence ?? '—';

  const text =
    `🤖 *AUTO TRADE EXECUTED*
` +
    `━━━━━━━━━━━━━━━━━━━━
` +
    `📌 Stock:       *${sym}*
` +
    `📋 Type:        *${act}*
` +
    `💵 Entry:       ${entry}
` +
    `🛑 SL:          ${sl}
` +
    `🎯 Target:      ${target}
` +
    `🔢 Qty:         ${qty}
` +
    `🧠 Confidence: ${conf}%
` +
    `━━━━━━━━━━━━━━━━━━━━
` +
    (result.orderId ? `🆔 Entry: \`${result.orderId}\`
` : '') +
    (result.slOrderId ? `🛑 SL:    \`${result.slOrderId}\`
` : '') +
    (result.targetOrderId ? `🎯 Target: \`${result.targetOrderId}\`` : '');

  try {
    await instance.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    console.log(`[Telegram] Auto-trade alert sent for ${sym}.`);
  } catch (err) {
    console.error(`[Telegram] Failed to send auto-trade alert: ${err.message}`);
  }
}

module.exports = { sendAlert, sendOrderAlert, sendMarketAlert, sendOcoAlert, sendAutoTradeAlert };

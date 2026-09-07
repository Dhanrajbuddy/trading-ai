'use strict';

/**
 * Preview Formatter — Builds the public-facing preview message and the
 * full signal message for paid users.
 *
 * PREVIEW: Exposes symbol, action, AI confidence, general setup reasons,
 * and timestamp. Does NOT expose entry, SL, target, qty, volume details,
 * or the full AI reasoning.
 *
 * FULL: The complete original signal — same data that the AI generated.
 */

/**
 * Format a Date (or timestamp ms) as a human-readable IST string.
 * @param {Date|number} d
 * @returns {string}
 */
function toIST(d) {
  return new Date(d).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).replace(',', '') + ' IST';
}

/**
 * Build a safe preview message for the Telegram channel.
 *
 * Exposed: symbol, action, AI confidence, general setup summary, timestamp.
 * Hidden: entry, SL, target, qty, positionValue, riskAmount, exact volume,
 * exact VWAP, RSI value, full AI reasoning.
 *
 * @param {Object} signal    Signal object from signalEngine
 * @param {Object} analysis  AI analysis from aiAnalyzer
 * @param {number} priceStars  Configured Stars price
 * @returns {string} Preview message text (Markdown)
 */
function formatPreview(signal, analysis, priceStars) {
  const emoji = signal.action === 'BUY' ? '🟢' : '🔴';

  // General setup reasons — show category only, not exact values
  const setupLines = [];
  if (signal.reasons && signal.reasons.length > 0) {
    for (const r of signal.reasons) {
      // Show the reason text but it's already generic (e.g. "ORB breakout above range + buffer")
      // These are strategy reasons, not price levels
      setupLines.push(`• ${r}`);
    }
  }

  const setupText = setupLines.length > 0
    ? setupLines.join('\n')
    : '• ORB breakout detected\n• Volume confirmation\n• Momentum alignment';

  return (
    `${emoji} *${signal.action} SIGNAL — ${signal.symbol}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🧠 AI Confidence: *${analysis.confidence}%*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 Setup detected:\n${setupText}\n\n` +
    `⏰ ${toIST(signal.timestamp)}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🔐 *PREMIUM SIGNAL*\n\n` +
    `Entry, Stop Loss, Target levels\n` +
    `and complete AI reasoning are locked.\n\n` +
    `⭐ ${priceStars} Stars to unlock`
  );
}

/**
 * Build the full signal message for a user who has paid.
 * This is the complete original signal — no data hidden.
 *
 * @param {Object} signal    Signal object from signalEngine
 * @param {Object} analysis  AI analysis from aiAnalyzer
 * @returns {string} Full signal message text (Markdown)
 */
function formatFullSignal(signal, analysis) {
  const emoji   = signal.action === 'BUY' ? '🟢' : '🔴';
  const confBar = '█'.repeat(Math.floor(analysis.confidence / 10)) +
                  '░'.repeat(10 - Math.floor(analysis.confidence / 10));

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
    `💬 _${analysis.reason}_\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📋 Reasons:\n${signal.reasons.map((r) => `  • ${r}`).join('\n')}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💵 Entry:       *₹${signal.entry}*\n` +
    `🛑 Stop Loss:   *₹${signal.stopLoss}*\n` +
    `🎯 Target:      *₹${signal.target}* (${signal.targetPct}%)\n` +
    `🔢 Qty:         ${signal.qty}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⏰ ${toIST(signal.timestamp)}`
  );
}

module.exports = { formatPreview, formatFullSignal, toIST };

'use strict';

/**
 * Risk Management Module
 *
 * Position sizing formula (fixed fractional):
 *   riskAmount    = capital × riskPerTrade          (default 1%)
 *   riskPerShare  = |entry - stopLoss|
 *   positionSize  = floor(riskAmount / riskPerShare)
 *
 * Capital is read from CAPITAL env var (default ₹1,00,000).
 * Risk percent is read from RISK_PERCENT env var (default 1%).
 *
 * The module is stateless — call calculatePositionSize() per signal.
 */

const DEFAULT_CAPITAL     = 100_000; // ₹1 lakh
const DEFAULT_RISK_PERCENT = 1;      // 1% per trade

/**
 * Get configured capital from env (INR).
 * @returns {number}
 */
function getCapital() {
  const val = parseFloat(process.env.CAPITAL);
  return Number.isFinite(val) && val > 0 ? val : DEFAULT_CAPITAL;
}

/**
 * Get configured risk percent from env.
 * Clamped to 0.1–5 % to prevent misconfiguration.
 * @returns {number}
 */
function getRiskPercent() {
  const val = parseFloat(process.env.RISK_PERCENT);
  if (!Number.isFinite(val)) return DEFAULT_RISK_PERCENT;
  return Math.min(Math.max(val, 0.1), 5);
}

/**
 * Calculate position size, risk amount and risk/reward ratio for a signal.
 *
 * @param {number} entry     Entry price (₹)
 * @param {number} stopLoss  Stop-loss price (₹)
 * @param {number} target    Target price (₹)
 * @returns {{
 *   capital:        number,   // configured capital in ₹
 *   riskPercent:    number,   // configured risk % per trade
 *   riskAmount:     number,   // ₹ risked on this trade
 *   riskPerShare:   number,   // ₹ risk per share = |entry - sl|
 *   positionSize:   number,   // shares to buy/sell (whole number)
 *   positionValue:  number,   // total ₹ deployed = positionSize × entry
 *   rewardAmount:   number,   // ₹ potential profit if target is hit
 *   rrRatio:        number,   // reward/risk ratio
 * }}
 */
function calculatePositionSize(entry, stopLoss, target) {
  const capital     = getCapital();
  const riskPercent = getRiskPercent();

  const riskAmount  = parseFloat((capital * riskPercent / 100).toFixed(2));
  const riskPerShare = Math.abs(entry - stopLoss);

  // Avoid division by zero (degenerate signal where entry === sl)
  if (riskPerShare === 0) {
    return {
      capital,
      riskPercent,
      riskAmount,
      riskPerShare: 0,
      positionSize:  0,
      positionValue: 0,
      rewardAmount:  0,
      rrRatio:       0,
    };
  }

  const positionSize  = Math.floor(riskAmount / riskPerShare);
  const positionValue = parseFloat((positionSize * entry).toFixed(2));
  const rewardAmount  = parseFloat((positionSize * Math.abs(target - entry)).toFixed(2));
  const rrRatio       = parseFloat((Math.abs(target - entry) / riskPerShare).toFixed(2));

  return {
    capital,
    riskPercent,
    riskAmount,
    riskPerShare:  parseFloat(riskPerShare.toFixed(2)),
    positionSize,
    positionValue,
    rewardAmount,
    rrRatio,
  };
}

module.exports = { calculatePositionSize, getCapital, getRiskPercent };

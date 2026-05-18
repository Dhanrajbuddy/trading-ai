'use strict';

/**
 * NSE Market Session Utility
 *
 * NSE trading hours (IST):
 *   Pre-open:  09:00 – 09:15
 *   Regular:   09:15 – 15:30
 *   Weekdays:  Monday (1) – Friday (5) only
 *
 * All times are computed in IST (UTC+5:30).
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return the current moment as an IST Date object.
 * @returns {Date}
 */
function nowIST() {
  const now = new Date();
  return new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
}

/**
 * Convert hours + minutes to total minutes-since-midnight.
 * @param {number} h
 * @param {number} m
 * @returns {number}
 */
function toMinutes(h, m) {
  return h * 60 + m;
}

// NSE trading window boundaries (in minutes since midnight IST)
const MARKET_OPEN_MINUTES  = toMinutes(9, 30);   // 09:30
const MARKET_CLOSE_MINUTES = toMinutes(15, 15);  // 15:15

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if NSE is currently in its regular trading session.
 *
 * Checks:
 *   1. Weekday is Mon–Fri
 *   2. Current IST time is within [09:15, 15:30)
 *
 * @returns {boolean}
 */
function isMarketOpen() {
  const ist     = nowIST();
  const weekday = ist.getUTCDay(); // 0=Sun, 1=Mon … 6=Sat
  if (weekday === 0 || weekday === 6) return false;

  const minutes = toMinutes(ist.getUTCHours(), ist.getUTCMinutes());
  return minutes >= MARKET_OPEN_MINUTES && minutes < MARKET_CLOSE_MINUTES;
}

/**
 * Return a human-readable market status string.
 * @returns {{ open: boolean, reason: string }}
 */
function marketStatusInfo() {
  const ist     = nowIST();
  const weekday = ist.getUTCDay();

  if (weekday === 0 || weekday === 6) {
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return { open: false, reason: `Market is closed on ${names[weekday]}s` };
  }

  const minutes = toMinutes(ist.getUTCHours(), ist.getUTCMinutes());

  if (minutes < MARKET_OPEN_MINUTES) {
    return { open: false, reason: 'Market has not opened yet (opens at 09:30 IST)' };
  }
  if (minutes >= MARKET_CLOSE_MINUTES) {
    return { open: false, reason: 'Market is closed for the day (closed at 15:15 IST)' };
  }

  return { open: true, reason: 'Market Open — Inside trading window (9:30–15:15 IST)' };
}

module.exports = { isMarketOpen, marketStatusInfo };

'use strict';

/**
 * Centralized in-memory logging service.
 *
 * Log types: "INFO" | "ERROR" | "SIGNAL" | "TRADE"
 * Capacity:  500 entries — oldest auto-evicted when full.
 */

const MAX_LOGS = 500;

/** @type {Array<{time: string, type: string, message: string, data: any}>} */
const _logs = [];

/**
 * Append a log entry. Evicts the oldest entry when capacity is exceeded.
 *
 * @param {'INFO'|'ERROR'|'SIGNAL'|'TRADE'} type
 * @param {string} message
 * @param {any}    [data]
 */
function log(type, message, data) {
  const entry = {
    time:    new Date().toISOString(),
    type,
    message,
    ...(data !== undefined && { data }),
  };

  _logs.push(entry);
  if (_logs.length > MAX_LOGS) _logs.shift();
}

/**
 * Return a shallow copy of all current log entries (oldest first).
 * @returns {Array<Object>}
 */
function getLogs() {
  return [..._logs];
}

/**
 * Remove all log entries.
 */
function clearLogs() {
  _logs.length = 0;
}

module.exports = { log, getLogs, clearLogs };

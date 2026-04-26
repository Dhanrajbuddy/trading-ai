'use strict';

/**
 * stockUniverse.js — Dynamic NSE Stock Selection
 *
 * Maintains a broad universe of liquid NSE stocks (Nifty 50).
 * Every 5 minutes, re-evaluates the latest market snapshot and
 * selects the TOP_N most active stocks as the working set.
 *
 * Selection strategy:
 *   • Top 7 gainers   — highest positive changePercent
 *   • Top 7 losers    — highest negative changePercent (also volatile/active)
 *   • Top 6 by volume — highest volumeMultiplier
 *   → Deduplicated → max TOP_N unique stocks
 *
 * Consumers:
 *   • zerodhaService  — uses NIFTY_UNIVERSE to know what to quote
 *   • orderService    — uses getActiveSymbols() for whitelist gate
 *   • index.js        — calls refreshIfStale() after each data fetch
 */

// ─── Universe ─────────────────────────────────────────────────────────────────

/**
 * Full candidate pool — Nifty 50 in Kite instrument format (NSE:SYMBOL).
 * All quotes are fetched for these 47 instruments every pipeline cycle.
 * The dynamic selection is a ranked subset of this pool.
 */
const NIFTY_UNIVERSE = [
  // Original 20 (Nifty large-cap core)
  'NSE:RELIANCE',   'NSE:TCS',        'NSE:INFY',       'NSE:HDFCBANK',   'NSE:ICICIBANK',
  'NSE:HINDUNILVR', 'NSE:SBIN',       'NSE:BHARTIARTL', 'NSE:ITC',        'NSE:KOTAKBANK',
  'NSE:LT',         'NSE:AXISBANK',   'NSE:BAJFINANCE', 'NSE:WIPRO',      'NSE:ULTRACEMCO',
  'NSE:ASIANPAINT', 'NSE:MARUTI',     'NSE:SUNPHARMA',  'NSE:TITAN',      'NSE:NESTLEIND',

  // Additional Nifty 50 constituents
  'NSE:ADANIENT',   'NSE:ADANIPORTS', 'NSE:APOLLOHOSP', 'NSE:BAJAJFINSV', 'NSE:BPCL',
  'NSE:BRITANNIA',  'NSE:CIPLA',      'NSE:COALINDIA',  'NSE:DIVISLAB',   'NSE:DRREDDY',
  'NSE:EICHERMOT',  'NSE:GRASIM',     'NSE:HCLTECH',    'NSE:HEROMOTOCO', 'NSE:HINDALCO',
  'NSE:INDUSINDBK', 'NSE:JSWSTEEL',   'NSE:LTIM',       'NSE:NTPC',       'NSE:ONGC',
  'NSE:POWERGRID',  'NSE:SHRIRAMFIN', 'NSE:TATACONSUM', 'NSE:TATAMOTORS', 'NSE:TATASTEEL',
  'NSE:TECHM',      'NSE:TRENT',
];

// ─── Config ───────────────────────────────────────────────────────────────────

const TOP_N       = 20;              // dynamic working set size
const REFRESH_MS  = 5 * 60 * 1000;  // 5-minute TTL

// ─── Cache ────────────────────────────────────────────────────────────────────

let _selectedStocks  = [];           // Array<stockObject>  — current top 20
let _selectedSymbols = new Set();    // Set<string>  bare tickers, e.g. 'RELIANCE'
let _lastRefreshedAt = 0;            // epoch ms of last refresh

// ─── Selection logic ──────────────────────────────────────────────────────────

/**
 * Pick the TOP_N most active stocks from a full market snapshot.
 *
 * Priority:
 *   1. Top 7 gainers  (changePercent  desc)
 *   2. Top 7 losers   (changePercent  asc  — negatives)
 *   3. Top 6 by volume(volumeMultiplier desc)
 *
 * @param {Array<Object>} allStocks
 * @returns {Array<Object>}
 */
function selectTopActive(allStocks) {
  if (!allStocks || allStocks.length === 0) return [];

  const gainers = [...allStocks]
    .filter((s) => s.changePercent > 0)
    .sort((a, b) => b.changePercent - a.changePercent)
    .slice(0, 7);

  const losers = [...allStocks]
    .filter((s) => s.changePercent < 0)
    .sort((a, b) => a.changePercent - b.changePercent)   // most negative first
    .slice(0, 7);

  const highVolume = [...allStocks]
    .sort((a, b) => b.volumeMultiplier - a.volumeMultiplier)
    .slice(0, 6);

  // Merge preserving priority order, deduplicate, cap at TOP_N
  const seen     = new Set();
  const selected = [];

  for (const s of [...gainers, ...losers, ...highVolume]) {
    if (!seen.has(s.symbol) && selected.length < TOP_N) {
      seen.add(s.symbol);
      selected.push(s);
    }
  }

  return selected;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * All Kite-format instruments in the candidate universe.
 * Used by zerodhaService to build the quote request.
 * @returns {string[]}
 */
function getUniverseInstruments() {
  return NIFTY_UNIVERSE;
}

/**
 * Refresh the dynamic selection if the cache is older than REFRESH_MS.
 * Called after every market-data fetch in runPipeline().
 *
 * @param {Array<Object>} allStocks  Full snapshot returned by getMarketData()
 * @returns {boolean}  true when the cache was actually updated
 */
function refreshIfStale(allStocks) {
  const now = Date.now();
  if (now - _lastRefreshedAt < REFRESH_MS) return false; // still fresh

  const selected      = selectTopActive(allStocks);
  _selectedStocks     = selected;
  _selectedSymbols    = new Set(selected.map((s) => s.symbol));
  _lastRefreshedAt    = now;

  console.log(
    `[StockUniverse] 🔄 Refreshed — selected ${_selectedSymbols.size}/${allStocks.length} stocks: ` +
    `[${[..._selectedSymbols].join(', ')}]`
  );

  return true;
}

/**
 * Force an immediate refresh, ignoring the TTL.
 * Useful on the very first pipeline run so the selection is available instantly.
 * @param {Array<Object>} allStocks
 */
function forceRefresh(allStocks) {
  _lastRefreshedAt = 0;
  refreshIfStale(allStocks);
}

/**
 * The current dynamic working set (top 20 active stocks).
 * @returns {Array<Object>}
 */
function getActiveStocks() {
  return _selectedStocks;
}

/**
 * Set of bare ticker symbols currently in the dynamic working set.
 * Used by orderService as an O(1) whitelist check.
 *
 * Fallback: if no refresh has happened yet (startup), returns the
 * full universe as bare tickers so manual orders are never spuriously blocked.
 *
 * @returns {Set<string>}
 */
function getActiveSymbols() {
  if (_selectedSymbols.size === 0) {
    // First-boot fallback — return all universe symbols stripped of prefix
    return new Set(NIFTY_UNIVERSE.map((i) => i.replace('NSE:', '')));
  }
  return _selectedSymbols;
}

/**
 * Snapshot of universe/cache metadata (for the /stocks/universe endpoint).
 * @returns {Object}
 */
function getUniverseState() {
  const now = Date.now();
  return {
    universeSize:      NIFTY_UNIVERSE.length,
    selectedCount:     _selectedStocks.length,
    selectedSymbols:   [..._selectedSymbols],
    lastRefreshedAt:   _lastRefreshedAt ? new Date(_lastRefreshedAt).toISOString() : null,
    nextRefreshIn:     _lastRefreshedAt
      ? `${Math.max(0, Math.round((REFRESH_MS - (now - _lastRefreshedAt)) / 1000))}s`
      : 'immediate',
    topN:              TOP_N,
    refreshIntervalMs: REFRESH_MS,
  };
}

module.exports = {
  getUniverseInstruments,
  refreshIfStale,
  forceRefresh,
  getActiveStocks,
  getActiveSymbols,
  getUniverseState,
};

'use strict';

/**
 * Zerodha Kite API Service
 *
 * Uses real market data when ZERODHA_API_KEY + ZERODHA_ACCESS_TOKEN are set.
 * Falls back to mock data automatically when credentials are missing.
 */

const axios = require('axios');
const { generateMarketData } = require('./mockData');
const { getUniverseInstruments } = require('./stockUniverse');

const KITE_BASE = 'https://api.kite.trade';

// ─── Per-symbol volume rate tracker (for real spike detection) ────────────────
// Compares the RATE at which volume is accumulating vs a rolling average.
// This properly detects sudden institutional buying/selling bursts.
const _prevVol  = {};   // symbol → { volume: number, ts: number }
const _avgRate  = {};   // symbol → EMA of volume-per-second rate

/**
 * Compute a meaningful volume multiplier by comparing the current
 * volume-accumulation RATE to the historical EMA of that rate.
 * Returns 1.0 on the first observation (no baseline yet).
 * @param {string} symbol
 * @param {number} volume  Current cumulative day volume
 * @returns {number} volumeMultiplier (e.g. 3.2 means volume is 3.2× the norm)
 */
function calcVolumeMultiplier(symbol, volume) {
  const now  = Date.now();
  const prev = _prevVol[symbol];

  // No previous data — seed and return neutral
  if (!prev || prev.volume === 0) {
    _prevVol[symbol] = { volume, ts: now };
    return 1.0;
  }

  const dtSecs = Math.max((now - prev.ts) / 1000, 1);
  const rate   = Math.max((volume - prev.volume) / dtSecs, 0); // shares/second this interval

  _prevVol[symbol] = { volume, ts: now };

  // Seed baseline on first real reading
  if (_avgRate[symbol] == null || _avgRate[symbol] === 0) {
    _avgRate[symbol] = rate;
    return 1.0;
  }

  // EMA of rate (slow decay → stable baseline)
  const k = 0.08;
  _avgRate[symbol] = rate * k + _avgRate[symbol] * (1 - k);

  if (_avgRate[symbol] <= 0) return 1.0;
  return parseFloat((rate / _avgRate[symbol]).toFixed(2));
}

/**
 * Check whether Zerodha credentials are configured
 * @returns {boolean}
 */
function hasZerodhaCredentials() {
  return !!(process.env.ZERODHA_API_KEY && process.env.ZERODHA_ACCESS_TOKEN);
}

/**
 * Build authenticated Axios headers for Kite API
 * @returns {Object}
 */
function kiteHeaders() {
  return {
    'X-Kite-Version': '3',
    Authorization: `token ${process.env.ZERODHA_API_KEY}:${process.env.ZERODHA_ACCESS_TOKEN}`,
  };
}

/**
 * Fetch LTP + OHLC + volume for all tracked instruments from Kite REST API
 * @returns {Promise<Array<Object>>}
 */
async function fetchFromKite() {
  const instrumentList = getUniverseInstruments().join('&i=');
  const url = `${KITE_BASE}/quote?i=${instrumentList}`;

  const response = await axios.get(url, {
    headers: kiteHeaders(),
    timeout: 8_000,
  });

  const quoteData = response.data.data;

  return Object.entries(quoteData).map(([instrumentKey, q]) => {
    const symbol     = instrumentKey.replace('NSE:', '');
    const price      = q.last_price;
    const prevClose  = q.ohlc.close;
    const changePerc = prevClose > 0
      ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2))
      : 0;
    const volume     = q.volume;
    const dayHigh    = q.ohlc.high;
    const dayLow     = q.ohlc.low;
    const open       = q.ohlc.open;

    // Use Zerodha's actual session VWAP (average_price IS the VWAP).
    // Fall back to (H+L+C)/3 only when average_price is not available.
    const vwap = q.average_price > 0
      ? parseFloat(q.average_price.toFixed(2))
      : parseFloat(((dayHigh + dayLow + price) / 3).toFixed(2));

    // Proper volume spike detection: rate-based vs rolling average
    const volumeMult = calcVolumeMultiplier(symbol, volume);
    const avgVolume  = volumeMult > 0 ? Math.round(volume / volumeMult) : volume;

    return {
      symbol,
      price,
      prevClose,
      open,
      high:    dayHigh,  // alias so signalEngine (stock.high) works correctly
      low:     dayLow,   // alias so signalEngine (stock.low)  works correctly
      dayHigh,
      dayLow,
      vwap,
      changePercent: changePerc,
      volume,
      avgVolume,
      volumeMultiplier: volumeMult,
      source: 'zerodha',
      timestamp: new Date().toISOString(),
    };
  });
}

/**
 * Get market data — uses Zerodha if configured, else mock
 * @returns {Promise<Array<Object>>}
 */
async function getMarketData() {
  if (!hasZerodhaCredentials()) {
    console.log('[DataSource] Using mock data (no Zerodha credentials)');
    const mock = generateMarketData();
    // Enrich mock with vwap + open + high/low aliases for scanner compatibility
    return mock.map((s) => ({
      ...s,
      open: parseFloat((s.prevClose * (1 + (Math.random() * 0.02 - 0.01))).toFixed(2)),
      high: s.dayHigh,
      low:  s.dayLow,
      vwap: parseFloat(((s.dayHigh + s.dayLow + s.price) / 3).toFixed(2)),
      source: 'mock',
    }));
  }

  try {
    console.log('[DataSource] Fetching live data from Zerodha Kite API...');
    const data = await fetchFromKite();
    console.log(`[DataSource] Fetched ${data.length} instruments from Kite`);
    return data;
  } catch (err) {
    console.warn(`[DataSource] Zerodha API error: ${err.message} — falling back to mock`);
    const mock = generateMarketData();
    return mock.map((s) => ({
      ...s,
      open: parseFloat((s.prevClose * (1 + (Math.random() * 0.02 - 0.01))).toFixed(2)),
      high: s.dayHigh,
      low:  s.dayLow,
      vwap: parseFloat(((s.dayHigh + s.dayLow + s.price) / 3).toFixed(2)),
      source: 'mock-fallback',
    }));
  }
}

module.exports = { getMarketData, hasZerodhaCredentials };

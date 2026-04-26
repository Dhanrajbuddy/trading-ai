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
    const avgVolume  = q.average_price > 0 ? Math.floor(volume / 2) : volume; // estimate
    const volumeMult = avgVolume > 0 ? parseFloat((volume / avgVolume).toFixed(2)) : 1;
    const dayHigh    = q.ohlc.high;
    const dayLow     = q.ohlc.low;
    const open       = q.ohlc.open;

    // Compute a simple intraday VWAP approximation: (H+L+C)/3
    const vwap = parseFloat(((dayHigh + dayLow + price) / 3).toFixed(2));

    return {
      symbol,
      price,
      prevClose,
      open,
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
    // Enrich mock with vwap + open for scanner compatibility
    return mock.map((s) => ({
      ...s,
      open: parseFloat((s.prevClose * (1 + (Math.random() * 0.02 - 0.01))).toFixed(2)),
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
      vwap: parseFloat(((s.dayHigh + s.dayLow + s.price) / 3).toFixed(2)),
      source: 'mock-fallback',
    }));
  }
}

module.exports = { getMarketData, hasZerodhaCredentials };

'use strict';

/**
 * seedRSI.js — On-startup candle history seeder.
 *
 * After any backend restart the in-memory _candle15History is empty, so RSI
 * is null until ~12:45 PM IST (needs 14 closed candles).  This utility fetches
 * the last few days of 15-min candles from Zerodha's historical API and injects
 * them into signalEngine via seedCandleHistory() so that:
 *   - RSI is available immediately from the first scan cycle
 *   - ORB is pre-seeded from today's first 2 candles (9:15–9:45 AM)
 *
 * Call seedRSIHistory() once at startup, before the pipeline begins.
 * All failures are non-fatal (best-effort) — missing data just means a symbol
 * starts fresh and will be ready once it builds enough live candles.
 */

const axios                = require('axios');
const { seedCandleHistory } = require('../strategies/signalEngine');
const { INSTRUMENT_TOKENS } = require('../backtest/backtestEngine');

/**
 * Fetch and inject historical 15-min candles for the given symbols.
 * @param {string[]} symbols  e.g. ['RELIANCE', 'TCS', ...]
 */
async function seedRSIHistory(symbols) {
  if (!process.env.ZERODHA_API_KEY || !process.env.ZERODHA_ACCESS_TOKEN) {
    console.log('[SeedRSI] Skipping — Zerodha credentials not set.');
    return;
  }

  // Fetch from 5 calendar days ago so a Monday startup gets Friday's data
  const ist    = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const today  = ist.toISOString().slice(0, 10);
  const fromDt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000 + 5.5 * 60 * 60 * 1000)
                   .toISOString().slice(0, 10);

  const headers = {
    'X-Kite-Version': '3',
    Authorization: `token ${process.env.ZERODHA_API_KEY}:${process.env.ZERODHA_ACCESS_TOKEN}`,
  };

  let seeded = 0, failed = 0;

  for (const sym of symbols) {
    const token = INSTRUMENT_TOKENS[sym.toUpperCase()];
    if (!token) continue;

    try {
      const url = `https://api.kite.trade/instruments/historical/${token}/15minute` +
                  `?from=${encodeURIComponent(fromDt + ' 09:00:00')}` +
                  `&to=${encodeURIComponent(today + ' 15:30:00')}&continuous=0&oi=0`;

      const resp = await axios.get(url, { headers, timeout: 10_000 });
      const raw  = resp.data?.data?.candles;
      if (!Array.isArray(raw) || raw.length === 0) continue;

      // Zerodha returns [ts, open, high, low, close, volume]
      // ts is an IST ISO string e.g. "2026-06-23T09:15:00+0530"
      const candles = raw.map(([ts, open, high, low, close, volume]) => ({
        ts, open, high, low, close, volume,
      }));

      seedCandleHistory(sym, candles);
      seeded++;
    } catch (err) {
      failed++;
    }
  }

  console.log(`[SeedRSI] ✅ Seeded ${seeded}/${symbols.length} symbols (${failed} failed/skipped)`);
}

module.exports = { seedRSIHistory };

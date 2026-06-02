'use strict';

/**
 * AI Analyzer — Data-Driven Confidence Scorer
 *
 * Confidence is built from four measurable factors instead of a random formula:
 *
 *   Factor 1 — Symbol historical win rate (from signalTracker)   0–35 pts
 *   Factor 2 — ORB signal quality score (from signalEngine)      0–30 pts
 *   Factor 3 — Volume strength                                   0–20 pts
 *   Factor 4 — Time-of-day (earlier = more runway to target)     0–15 pts
 *
 * Total: 0–100. Clamped to 40–92 so extremes don't mislead.
 *
 * When OPENAI_API_KEY is set, the factors are sent as structured context
 * to GPT which reasons over them and returns its own 0–100 score.
 * That score is blended 50/50 with the factor model for stability.
 *
 * What "confidence" means:
 *   It is NOT a probability of profit. It is a composite quality score
 *   for how well this signal aligns with the ORB strategy rules AND
 *   how well similar setups have performed historically.
 *   Interpretation: ≥75 = high quality setup, 60–74 = moderate, <60 = weak.
 */

const axios = require('axios');
const { getSymbolStats, getRecentOutcomes } = require('./signalTracker');

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

// ─── Factor model ─────────────────────────────────────────────────────────────

/**
 * Factor 1 — Symbol historical win rate (0–35 pts)
 *
 * Uses the win rate recorded by signalTracker from past resolved signals.
 * When fewer than 5 decided trades exist for a symbol, we use the
 * portfolio-wide baseline (ORB backtest: ~46.7%) to avoid overconfidence
 * from a tiny sample.
 *
 * Mapping: WR ≥ 65% → 35pts | 55% → 28pts | 46.7% (baseline) → 22pts | ≤35% → 10pts
 */
function symbolWinRateScore(symbol) {
  const stats = getSymbolStats(symbol);

  // Not enough data — use backtest baseline (46.7% WR → 22 pts)
  if (!stats || stats.winRate === null || (stats.wins + stats.losses) < 5) {
    return { pts: 22, note: `baseline (${stats.trades} trades observed, need 5+ decided)` };
  }

  const wr = stats.winRate; // 0.0–1.0
  let pts;
  if      (wr >= 0.65) pts = 35;
  else if (wr >= 0.55) pts = 28;
  else if (wr >= 0.45) pts = 22;
  else if (wr >= 0.35) pts = 15;
  else                 pts = 10;

  return { pts, note: `${(wr * 100).toFixed(1)}% WR from ${stats.wins + stats.losses} trades` };
}

/**
 * Factor 2 — ORB signal quality score (0–30 pts)
 *
 * signalEngine already computes a 0–100 score based on:
 *   RSI position (40pts), volume (40pts), VWAP alignment (20pts).
 * We scale that to 0–30 pts here.
 */
function orbQualityScore(signal) {
  const raw = signal.score ?? 60; // default to 60 if not present
  const pts = Math.round((raw / 100) * 30);
  return { pts, note: `ORB score ${raw}/100` };
}

/**
 * Factor 3 — Volume strength (0–20 pts)
 *
 * Higher than normal volume = stronger conviction behind the breakout.
 * Uses the volumeMultiplier computed by zerodhaService (rate-based EMA).
 */
function volumeScore(signal) {
  const vm = signal.volumeMultiplier ?? 1.0;
  let pts;
  if      (vm >= 4.0) pts = 20;
  else if (vm >= 3.0) pts = 17;
  else if (vm >= 2.0) pts = 13;
  else if (vm >= 1.5) pts = 8;
  else                pts = 3;
  return { pts, note: `volume ${vm.toFixed(1)}x average` };
}

/**
 * Factor 4 — Time-of-day (0–15 pts)
 *
 * Earlier signals have more session runway to reach target before 3:15 PM squareoff.
 * 09:30–11:00 = prime window (full 15 pts)
 * 11:00–12:30 = good (10 pts)
 * 12:30–13:30 = moderate (6 pts)
 * 13:30–14:30 = late (3 pts — less time, higher squareoff risk)
 */
function timeOfDayScore() {
  const ist  = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if      (mins <= 11 * 60)      return { pts: 15, note: 'prime window 9:30–11:00' };
  else if (mins <= 12 * 60 + 30) return { pts: 10, note: 'good window 11:00–12:30' };
  else if (mins <= 13 * 60 + 30) return { pts: 6,  note: 'moderate window 12:30–13:30' };
  else                           return { pts: 3,  note: 'late session >13:30' };
}

/**
 * Detect recent strategy drift — if last 5 decided trades lost ≥4, penalise.
 * Returns a penalty (negative pts) or 0.
 */
function recentDriftPenalty() {
  const recent = getRecentOutcomes(5);
  const decided = recent.filter((o) => o.result === 'WIN' || o.result === 'LOSS');
  if (decided.length < 4) return 0; // not enough data to penalise
  const losses = decided.filter((o) => o.result === 'LOSS').length;
  if (losses >= 4) return -8; // 4–5 consecutive losses: strategy may be off
  if (losses >= 3) return -4; // 3 losses in last 5: slight caution
  return 0;
}

/**
 * Build the structured confidence score from all four factors.
 * @param {Object} signal
 * @returns {{ confidence: number, reason: string, breakdown: Object }}
 */
function computeFactorScore(signal) {
  const f1 = symbolWinRateScore(signal.symbol);
  const f2 = orbQualityScore(signal);
  const f3 = volumeScore(signal);
  const f4 = timeOfDayScore();
  const drift = recentDriftPenalty();

  const raw   = f1.pts + f2.pts + f3.pts + f4.pts + drift;
  // Clamp: 40 min (any valid ORB signal has baseline value) / 92 max (never show 100)
  const score = Math.max(40, Math.min(92, raw));

  const parts = [
    `Symbol history: ${f1.note}`,
    `ORB quality: ${f2.note}`,
    `Volume: ${f3.note}`,
    `Timing: ${f4.note}`,
  ];
  if (drift < 0) parts.push(`Recent drift penalty: ${drift}pts`);

  return {
    confidence: score,
    reason: parts.join('; '),
    breakdown: { winRatePts: f1.pts, orbPts: f2.pts, volumePts: f3.pts, timePts: f4.pts, driftPenalty: drift },
    source: 'factor-model',
  };
}

// ─── OpenAI path ──────────────────────────────────────────────────────────────

function buildPrompt(signal, factorResult) {
  const stats = getSymbolStats(signal.symbol);
  return (
    `You are a quantitative trading analyst. Evaluate this NSE intraday ORB signal.\n` +
    `Reply ONLY with valid JSON: { "signal": "BUY"|"SELL", "confidence": <integer 0-100>, "reason": "<one concise sentence>" }\n\n` +
    `Signal:\n` +
    `  Symbol:          ${signal.symbol}\n` +
    `  Action:          ${signal.action}\n` +
    `  Price:           ₹${signal.price}\n` +
    `  Change %:        ${signal.changePercent}%\n` +
    `  Volume mult:     ${signal.volumeMultiplier}x\n` +
    `  VWAP:            ₹${signal.vwap || 'N/A'}\n` +
    `  EMA20:           ₹${signal.ema20 || 'N/A'}\n` +
    `  Entry:           ₹${signal.entry}\n` +
    `  Stop-Loss:       ₹${signal.stopLoss}\n` +
    `  Target:          ₹${signal.target}\n` +
    `  ORB reasons:     ${(signal.reasons || []).join('; ')}\n\n` +
    `Historical context:\n` +
    `  Symbol trades tracked: ${stats.trades}\n` +
    `  Symbol win rate:       ${stats.winRate != null ? (stats.winRate * 100).toFixed(1) + '%' : 'insufficient data'}\n` +
    `  Factor model score:    ${factorResult.confidence}/100\n` +
    `  Factor breakdown:      ${factorResult.reason}\n`
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Analyse a trading signal and return a data-driven confidence score.
 * @param {Object} signal
 * @returns {Promise<{ signal: string, confidence: number, reason: string, source: string, breakdown?: Object }>}
 */
async function analyzeSignal(signal) {
  // Always compute the factor model score first — used as fallback and as context for GPT
  const factorResult = computeFactorScore(signal);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      signal:     signal.action,
      confidence: factorResult.confidence,
      reason:     factorResult.reason,
      breakdown:  factorResult.breakdown,
      source:     'factor-model',
    };
  }

  // Blend GPT score with factor model 50/50 for stability
  try {
    const response = await axios.post(
      OPENAI_ENDPOINT,
      {
        model:       'gpt-4o-mini',
        messages:    [{ role: 'user', content: buildPrompt(signal, factorResult) }],
        max_tokens:  120,
        temperature: 0.1,
      },
      {
        headers: {
          Authorization:  `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
      }
    );

    const raw  = response.data.choices[0].message.content.trim();
    const json = JSON.parse(raw);
    const gptScore   = Math.max(0, Math.min(100, json.confidence ?? 50));
    const blended    = Math.round((gptScore + factorResult.confidence) / 2);

    return {
      signal:     json.signal     ?? signal.action,
      confidence: blended,
      reason:     json.reason     ?? factorResult.reason,
      breakdown:  factorResult.breakdown,
      source:     'openai+factor-model',
    };
  } catch (err) {
    console.warn(`[AI] OpenAI call failed (${err.message}), using factor model.`);
    return {
      signal:     signal.action,
      confidence: factorResult.confidence,
      reason:     factorResult.reason,
      breakdown:  factorResult.breakdown,
      source:     'factor-model',
    };
  }
}

module.exports = { analyzeSignal };

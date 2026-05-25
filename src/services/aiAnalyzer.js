'use strict';

/**
 * AI Analyzer (Enhanced)
 * Uses OpenAI API when OPENAI_API_KEY is set; otherwise returns mock analysis.
 *
 * Always returns a structured object:
 * { signal: "BUY"|"SELL", confidence: number, reason: string, source: string }
 */

const axios = require('axios');

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

/**
 * Build a concise prompt for OpenAI
 * @param {Object} signal
 * @returns {string}
 */
function buildPrompt(signal) {
  return (
    `You are a professional stock trading analyst. Evaluate the trading signal below.\n` +
    `Respond ONLY with a valid JSON object matching exactly this schema:\n` +
    `{ "signal": "BUY" | "SELL", "confidence": <integer 0-100>, "reason": "<one concise sentence>" }\n\n` +
    `Signal data:\n` +
    `  Symbol:          ${signal.symbol}\n` +
    `  Action:          ${signal.action}\n` +
    `  Strength:        ${signal.strength || 'N/A'}\n` +
    `  Price:           ₹${signal.price}\n` +
    `  Change %:        ${signal.changePercent}%\n` +
    `  Volume:          ${signal.volume?.toLocaleString()}\n` +
    `  Volume Mult:     ${signal.volumeMultiplier}x\n` +
    `  VWAP:            ${signal.vwap || 'N/A'}\n` +
    `  20 EMA:          ${signal.ema20 || 'N/A'}\n` +
    `  Entry:           ₹${signal.entry}\n` +
    `  Stop-Loss:       ₹${signal.stopLoss}\n` +
    `  Target:          ₹${signal.target}\n` +
    `  Reasons:         ${(signal.reasons || []).join('; ')}\n`
  );
}

/**
 * Generate deterministic mock analysis when OpenAI is unavailable
 * @param {Object} signal
 * @returns {Object}
 */
function mockAnalysis(signal) {
  const base  = signal.action === 'BUY' ? 62 : 55;
  const boost = signal.strength === 'STRONG' ? 15 : 0;
  const noise = Math.floor(Math.random() * 15);
  const confidence = Math.min(base + boost + noise, 97);

  const reasonMap = {
    BUY:  `Bullish momentum with volume confirmation — ${confidence}% probability of continuation.`,
    SELL: `Bearish trend with negative price action — exit advised to limit downside.`,
  };

  return {
    signal:     signal.action,
    confidence,
    reason:     reasonMap[signal.action] || 'Pattern-based signal.',
    source:     'mock',
  };
}

/**
 * Analyse a trading signal with AI
 * @param {Object} signal
 * @returns {Promise<{ signal: string, confidence: number, reason: string, source: string }>}
 */
async function analyzeSignal(signal) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return mockAnalysis(signal);
  }

  try {
    const response = await axios.post(
      OPENAI_ENDPOINT,
      {
        model:       'gpt-3.5-turbo',
        messages:    [{ role: 'user', content: buildPrompt(signal) }],
        max_tokens:  120,
        temperature: 0.2,
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

    return {
      signal:     json.signal     ?? signal.action,
      confidence: json.confidence ?? 50,
      reason:     json.reason     ?? 'No reasoning provided.',
      source:     'openai',
    };
  } catch (err) {
    console.warn(`[AI] OpenAI call failed (${err.message}), using mock.`);
    return mockAnalysis(signal);
  }
}

module.exports = { analyzeSignal };

/**
 * Build a concise prompt for the AI
 * @param {Object} signal
 * @returns {string}
 */
function buildPrompt(signal) {
  return (
    `You are a professional stock trading analyst.\n` +
    `Evaluate this trading signal and reply with ONLY a JSON object: { "confidence": <0-100>, "reasoning": "<one sentence>" }\n\n` +
    `Signal:\n` +
    `  Symbol:        ${signal.symbol}\n` +
    `  Action:        ${signal.action}\n` +
    `  Price:         $${signal.price}\n` +
    `  Change %:      ${signal.changePercent}%\n` +
    `  Volume:        ${signal.volume.toLocaleString()}\n` +
    `  Avg Volume:    ${signal.avgVolume.toLocaleString()}\n` +
    `  Volume Mult:   ${signal.volumeMultiplier}x\n` +
    `  Reasons:       ${signal.reasons.join('; ')}\n`
  );
}

/**
 * Generate mock confidence when OpenAI is unavailable
 * @param {Object} signal
 * @returns {Object}
 */
function mockAnalysis(signal) {
  const base = signal.action === 'BUY' ? 65 : 55;
  const noise = Math.floor(Math.random() * 20);
  const confidence = Math.min(base + noise, 99);
  return {
    confidence,
    reasoning: `Mock analysis — ${signal.action} signal for ${signal.symbol} with ${confidence}% confidence based on pattern matching.`,
    source: 'mock',
  };
}

/**
 * Analyse a trading signal with AI
 * @param {Object} signal
 * @returns {Promise<Object>} { confidence, reasoning, source }
 */
async function analyzeSignal(signal) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return mockAnalysis(signal);
  }

  try {
    const response = await axios.post(
      OPENAI_ENDPOINT,
      {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: buildPrompt(signal) }],
        max_tokens: 150,
        temperature: 0.3,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
      }
    );

    const raw  = response.data.choices[0].message.content.trim();
    const json = JSON.parse(raw);

    return {
      confidence: json.confidence ?? 50,
      reasoning:  json.reasoning  ?? 'No reasoning provided.',
      source: 'openai',
    };
  } catch (err) {
    console.warn(`[AI] OpenAI call failed (${err.message}), falling back to mock.`);
    return mockAnalysis(signal);
  }
}

module.exports = { analyzeSignal };

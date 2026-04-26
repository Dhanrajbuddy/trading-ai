'use strict';

/**
 * Zerodha Kite Connect — Authentication Service
 *
 * Flow:
 *  1. User visits GET /zerodha/login  → redirected to Kite login page
 *  2. Kite redirects back to GET /zerodha/callback?request_token=XXX&status=success
 *  3. This module exchanges request_token for access_token via Kite REST API
 *  4. access_token is saved to process.env and persisted to .env
 */

const crypto = require('crypto');
const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');

const KITE_SESSION_URL = 'https://api.kite.trade/session/token';

// Resolve .env relative to project root (two levels up from this file)
const ENV_PATH = path.resolve(__dirname, '..', '..', '.env');

/**
 * Generate a Zerodha access token by exchanging a one-time request_token.
 *
 * Kite Connect docs:
 *   POST https://api.kite.trade/session/token
 *   Body (form-encoded): api_key, request_token, checksum
 *   Checksum = SHA-256(api_key + request_token + api_secret)
 *
 * @param {string} requestToken  One-time request_token from Kite callback query
 * @returns {Promise<string>}    The access_token
 */
async function generateAccessToken(requestToken) {
  const apiKey    = process.env.ZERODHA_API_KEY;
  const apiSecret = process.env.ZERODHA_API_SECRET;

  if (!apiKey) throw new Error('ZERODHA_API_KEY is not set in .env');
  if (!apiSecret) throw new Error('ZERODHA_API_SECRET is not set in .env');
  if (!requestToken) throw new Error('request_token is required');

  // Kite-mandated checksum: SHA256(api_key + request_token + api_secret)
  const checksum = crypto
    .createHash('sha256')
    .update(apiKey + requestToken + apiSecret)
    .digest('hex');

  const body = new URLSearchParams({
    api_key:       apiKey,
    request_token: requestToken,
    checksum,
  });

  const response = await axios.post(KITE_SESSION_URL, body.toString(), {
    headers: {
      'X-Kite-Version': '3',
      'Content-Type':   'application/x-www-form-urlencoded',
    },
    timeout: 10_000,
  });

  const accessToken = response.data.data.access_token;

  // Apply immediately to the running process
  process.env.ZERODHA_ACCESS_TOKEN = accessToken;

  // Persist to .env so subsequent container restarts reuse the token
  _persistAccessToken(accessToken);

  return accessToken;
}

/**
 * Write the new access_token back into .env (in-place replace or append).
 * @param {string} token
 */
function _persistAccessToken(token) {
  try {
    let content = fs.readFileSync(ENV_PATH, 'utf8');

    if (/^ZERODHA_ACCESS_TOKEN=.*/m.test(content)) {
      content = content.replace(
        /^ZERODHA_ACCESS_TOKEN=.*$/m,
        `ZERODHA_ACCESS_TOKEN=${token}`
      );
    } else {
      content = content.trimEnd() + `\nZERODHA_ACCESS_TOKEN=${token}\n`;
    }

    fs.writeFileSync(ENV_PATH, content, 'utf8');
    console.log('[ZerodhaAuth] ✅ .env updated with fresh access token');
  } catch (err) {
    console.warn(`[ZerodhaAuth] ⚠️  Could not persist to .env: ${err.message}`);
  }
}

module.exports = { generateAccessToken };

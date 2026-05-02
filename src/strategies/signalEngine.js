'use strict';

/**
 * Signal Engine — Simple Intraday NSE Strategy
 *
 * Entry conditions (BUY):  Price > EMA20, RSI > 55, bullish candle, volume >= 1.3x
 * Entry conditions (SELL): Price < EMA20, RSI < 45, bearish candle, volume >= 1.3x
 * Skip: RSI 45–55 (neutral zone — no trade)
 * SL:     fixed 0.3% from entry
 * Target: fixed 0.8% from entry
 * Window: 9:30 AM – 3:15 PM IST, no overnight carry
 * Max 1 trade per day per symbol
 */

const { log } = require('../services/logger');
const { sendMarketClosedAlert } = require('../alerts/telegramAlert');

// ─── Config ───────────────────────────────────────────────────────────────────

const MIN_CONFIDENCE    = 50;             // minimum score to emit a signal
const RSI_PERIOD        = 14;
const VOLUME_SPIKE_MIN  = 1.5;           // minimum volume multiplier for entry
const SL_PCT            = 0.3;           // 0.3% fixed stop loss
const TARGET_PCT        = 1.2;           // 1.2% fixed target
const CAPITAL_PER_TRADE = 20000;         // fixed ₹20,000 capital per trade
const PRICE_HISTORY_MAX = 60;            // rolling window per symbol
const COOLDOWN_MS       = 15 * 60 * 1000; // 15-minute repeat-signal block
const MAX_TRADES_PER_DAY = 1;            // max signals per symbol per day

// Trading window (IST): 9:30 AM – 2:30 PM (no new entries after 2:30 PM)
const WINDOW_START_MINS  = 9 * 60 + 30;  // 570 = 9:30 AM
const ENTRY_CUTOFF_MINS  = 12 * 60 + 30; // 750 = 12:30 PM

// ─── Per-run in-memory state ──────────────────────────────────────────────────

const _priceHistory   = {};  // symbol → number[]  (oldest-first)
const _lastSignalTime = {};  // symbol → epoch ms
const _tradesToday    = {};  // symbol → { date: 'YYYY-MM-DD', count: number }
const _prevCandle     = {};  // symbol → { high, low } from previous scan cycle
const _pendingSignal  = {};  // symbol → { action, signalPrice, score } awaiting next-scan confirmation

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isWithinTradingWindow() {
  const ist  = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const day  = ist.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= WINDOW_START_MINS && mins <= ENTRY_CUTOFF_MINS;
}

function getTodayIST() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10); // YYYY-MM-DD
}

function isOnCooldown(symbol) {
  const last = _lastSignalTime[symbol];
  return last != null && (Date.now() - last) < COOLDOWN_MS;
}

function markSignalTime(symbol) {
  _lastSignalTime[symbol] = Date.now();
  const today = getTodayIST();
  if (!_tradesToday[symbol] || _tradesToday[symbol].date !== today) {
    _tradesToday[symbol] = { date: today, count: 0 };
  }
  _tradesToday[symbol].count++;
}

function isMaxTradesReached(symbol) {
  const today = getTodayIST();
  const rec   = _tradesToday[symbol];
  return rec && rec.date === today && rec.count >= MAX_TRADES_PER_DAY;
}

function updatePriceHistory(symbol, price, seedPrice) {
  if (!_priceHistory[symbol]) {
    const seed = seedPrice || price;
    _priceHistory[symbol] = new Array(RSI_PERIOD + 1).fill(seed);
  }
  _priceHistory[symbol].push(price);
  if (_priceHistory[symbol].length > PRICE_HISTORY_MAX) {
    _priceHistory[symbol].shift();
  }
}

function computeRSI(prices) {
  if (!prices || prices.length < RSI_PERIOD + 1) return null;
  let gains = 0, losses = 0;
  const slice = prices.slice(-(RSI_PERIOD + 1));
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff > 0) gains  += diff;
    else          losses -= diff;
  }
  const avgGain = gains  / RSI_PERIOD;
  const avgLoss = losses / RSI_PERIOD;
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(1));
}

function strengthLabel(confidence) {
  if (confidence >= 80) return 'STRONG';
  if (confidence >= 60) return 'MEDIUM';
  return 'WEAK';
}

// ─── Trading cost model (Zerodha NSE equity intraday) ────────────────────────
function calcTradingCosts(action, entryPrice, exitPrice, qty) {
  const entryVal    = entryPrice * qty;
  const exitVal     = exitPrice  * qty;
  const slippage    = (entryVal + exitVal) * 0.0010;
  const brokEntry   = Math.min(entryVal * 0.0003, 20);
  const brokExit    = Math.min(exitVal  * 0.0003, 20);
  const sellVal     = action === 'BUY' ? exitVal : entryVal;
  const stt         = sellVal * 0.00025;
  const exchCharges = (entryVal + exitVal) * 0.0000325;
  const gst         = (brokEntry + brokExit + exchCharges) * 0.18;
  return parseFloat((slippage + brokEntry + brokExit + stt + exchCharges + gst).toFixed(2));
}

// ─── Scoring (simple — based on 4 clean conditions) ──────────────────────────

/**
 * Score a signal. Max 100.
 *   Base (all 4 entry gates passed):  40
 *   RSI quality bonus:               +20  (>60 BUY / <40 SELL = strong momentum)
 *   Volume quality bonus:            +20  (≥2× = strong; 3× = very strong)
 *   VWAP alignment bonus:            +20  (price above VWAP for BUY / below for SELL)
 */
function scoreSignal(action, stock, rsi) {
  let score = 40;  // base: all 4 gates cleared
  const reasons = [];

  // 1. RSI quality
  if (action === 'BUY') {
    if (rsi !== null && rsi >= 60) {
      score += 20;
      reasons.push(`RSI ${rsi} — strong bullish momentum (≥60)`);
    } else if (rsi !== null && rsi >= 50) {
      score += 10;
      reasons.push(`RSI ${rsi} — moderate bullish momentum (50–60)`);
    }
  } else {
    if (rsi !== null && rsi <= 40) {
      score += 20;
      reasons.push(`RSI ${rsi} — strong bearish momentum (≤40)`);
    } else if (rsi !== null && rsi < 50) {
      score += 10;
      reasons.push(`RSI ${rsi} — moderate bearish momentum (40–50)`);
    }
  }

  // 2. Volume quality
  const vm = stock.volumeMultiplier;
  if (vm != null) {
    if (vm >= 3.0) {
      score += 20;
      reasons.push(`Volume ${vm.toFixed(1)}x — strong institutional activity`);
    } else if (vm >= 2.0) {
      score += 15;
      reasons.push(`Volume ${vm.toFixed(1)}x — good volume confirmation`);
    } else if (vm >= 1.5) {
      score += 8;
      reasons.push(`Volume ${vm.toFixed(1)}x — volume spike confirmed`);
    }
  }

  // 3. VWAP alignment
  if (stock.vwap != null) {
    const aligned = (action === 'BUY' && stock.price > stock.vwap) ||
                    (action === 'SELL' && stock.price < stock.vwap);
    if (aligned) {
      score += 20;
      reasons.push(`Price ${action === 'BUY' ? 'above' : 'below'} VWAP ₹${stock.vwap} — intraday bias confirmed`);
    }
  }

  return { score: Math.min(score, 100), reasons };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Generate trading signals from a market snapshot.
 * @param {Array}  stocks   Market snapshot (ema20 attached by marketScanner)
 * @param {Object} scanData { topGainers, volumeSpikes, breakouts, vwapBreakouts, emaCrosses }
 * @returns {Array<Object>} Signals sorted by confidence desc, empty [] outside window
 */
function generateSignals(stocks, scanData) {
  const { volumeSpikes } = scanData;

  if (!isWithinTradingWindow()) {
    const ist  = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const day  = ist.getUTCDay();
    const reason = (day === 0 || day === 6) ? 'Weekend — market closed' : 'Outside trading window (9:30–12:30 IST)';
    console.log(`[SignalEngine] ${reason}. No signals.`);
    log('INFO', `⛔ Market Closed — ${reason}. No signals generated.`);
    sendMarketClosedAlert();
    return [];
  }

  const spikeSymbols = new Set((volumeSpikes || []).map((s) => s.symbol));
  const signals      = [];

  for (const stock of stocks) {
    const ema20 = stock.ema20 ?? null;

    // Update price history and compute RSI
    updatePriceHistory(stock.symbol, stock.price, stock.prevClose);
    const rsi = computeRSI(_priceHistory[stock.symbol]);
    // ── Pending confirmation check (from previous scan cycle) ──────────────────
    const pending = _pendingSignal[stock.symbol];
    if (pending) {
      delete _pendingSignal[stock.symbol];
      const confirmed = (pending.action === 'BUY'  && stock.open != null && stock.price > stock.open) ||
                        (pending.action === 'SELL' && stock.open != null && stock.price < stock.open);
      if (confirmed && !isMaxTradesReached(stock.symbol)) {
        const pEntry  = stock.price;
        const pSl     = pending.action === 'BUY'
          ? parseFloat((pEntry * (1 - SL_PCT / 100)).toFixed(2))
          : parseFloat((pEntry * (1 + SL_PCT / 100)).toFixed(2));
        const pTarget = pending.action === 'BUY'
          ? parseFloat((pEntry * (1 + TARGET_PCT / 100)).toFixed(2))
          : parseFloat((pEntry * (1 - TARGET_PCT / 100)).toFixed(2));
        const pQty    = Math.floor(CAPITAL_PER_TRADE / pEntry);
        if (pQty > 0) {
          const pExpProfit = Math.abs(pTarget - pEntry) * pQty;
          const pExpCost   = calcTradingCosts(pending.action, pEntry, pTarget, pQty);
          if (pExpProfit > pExpCost) {
            markSignalTime(stock.symbol);
            console.log(`[SignalEngine] ✅ ${pending.action} ${stock.symbol} CONFIRMED | price=₹${pEntry} | SL=₹${pSl} | Target=₹${pTarget}`);
            log('SIGNAL', 'Signal confirmed', { symbol: stock.symbol, action: pending.action, score: pending.score, rsi, entry: pEntry, sl: pSl, target: pTarget });
            signals.push({
              symbol:           stock.symbol,
              action:           pending.action,
              strength:         strengthLabel(pending.score),
              confidence:       pending.score,
              price:            pEntry,
              changePercent:    stock.changePercent,
              volume:           stock.volume,
              avgVolume:        stock.avgVolume,
              volumeMultiplier: stock.volumeMultiplier,
              ema20:            stock.ema20 ?? null,
              vwap:             stock.vwap ?? null,
              rsi,
              entry:            pEntry,
              stopLoss:         pSl,
              slType:           'fixed-0.3%',
              target:           pTarget,
              qty:              pQty,
              positionValue:    parseFloat((pEntry * pQty).toFixed(2)),
              capitalPerTrade:  CAPITAL_PER_TRADE,
              expectedProfit:   parseFloat(pExpProfit.toFixed(2)),
              expectedCost:     parseFloat(pExpCost.toFixed(2)),
              reasons:          [`Confirmed: price ₹${pEntry} ${pending.action === 'BUY' ? '>' : '<'} signal price ₹${pending.signalPrice}`],
              source:           stock.source ?? 'unknown',
              timestamp:        stock.timestamp,
              confirmed:        true,
            });
          }
        }
      } else {
        console.log(`[SignalEngine] ✗ ${stock.symbol} ${pending.action} confirmation missed — candle not ${pending.action === 'BUY' ? 'bullish' : 'bearish'} (price=₹${stock.price} open=₹${stock.open ?? 'N/A'})`);
      }
      continue; // one action per scan per symbol
    }
    // ── Max trades per day gate ─────────────────────────────────────────────
    if (isMaxTradesReached(stock.symbol)) {
      continue;
    }

    // ── Cooldown gate ───────────────────────────────────────────────────────
    if (isOnCooldown(stock.symbol)) {
      const minsLeft = Math.ceil((COOLDOWN_MS - (Date.now() - _lastSignalTime[stock.symbol])) / 60_000);
      console.log(`[SignalEngine] ${stock.symbol} cooldown (${minsLeft} min left)`);
      continue;
    }

    if (ema20 === null) continue;

    // Capture current candle data and update previous candle state
    const candleHigh = stock.high ?? stock.price;
    const candleLow  = stock.low  ?? stock.price;
    const prev       = _prevCandle[stock.symbol] ?? null;
    _prevCandle[stock.symbol] = { high: candleHigh, low: candleLow };

    // ── Avoid sideways (candle range < 0.2% of price) ──────────────────────
    if ((candleHigh - candleLow) / stock.price < 0.002) continue;

    // ── Entry gates ─────────────────────────────────────────────────────────────
    const priceAboveEMA  = stock.price > ema20;
    const priceBelowEMA  = stock.price < ema20;
    const rsiAbove58     = rsi !== null && rsi > 58;
    const rsiBelow42     = rsi !== null && rsi < 42;
    const rsiNeutral     = rsi !== null && rsi >= 42 && rsi <= 58;
    const bullishCandle  = stock.open != null && stock.price > stock.open;
    const bearishCandle  = stock.open != null && stock.price < stock.open;
    const hasVolumeSpike = spikeSymbols.has(stock.symbol) ||
                           (stock.volumeMultiplier != null && stock.volumeMultiplier >= VOLUME_SPIKE_MIN);

    // Skip RSI neutral zone (42–58) — no clear directional bias
    if (rsiNeutral) continue;

    const isBuy  = priceAboveEMA && rsiAbove58 && bullishCandle && hasVolumeSpike;
    const isSell = priceBelowEMA && rsiBelow42 && bearishCandle && hasVolumeSpike;

    if (!isBuy && !isSell) continue;

    const action = isBuy ? 'BUY' : 'SELL';

    // ── Score signal ────────────────────────────────────────────────────────
    const { score, reasons: condReasons } = scoreSignal(action, stock, rsi);

    if (score < MIN_CONFIDENCE) {
      console.log(`[SignalEngine] ✗ ${stock.symbol} ${action} rejected | score=${score}/${MIN_CONFIDENCE}`);
      log('SIGNAL', 'Signal rejected', { symbol: stock.symbol, action, score, threshold: MIN_CONFIDENCE });
      continue;
    }

    // ── Fixed SL and target ─────────────────────────────────────────────────
    const entry  = stock.price;
    const sl = action === 'BUY'
      ? parseFloat((entry * (1 - SL_PCT / 100)).toFixed(2))
      : parseFloat((entry * (1 + SL_PCT / 100)).toFixed(2));
    const target = action === 'BUY'
      ? parseFloat((entry * (1 + TARGET_PCT / 100)).toFixed(2))
      : parseFloat((entry * (1 - TARGET_PCT / 100)).toFixed(2));

    // ── Fixed position size: ₹20,000 per trade ─────────────────────────────
    const qty = Math.floor(CAPITAL_PER_TRADE / entry);
    if (qty <= 0) continue;

    // ── Cost viability filter ───────────────────────────────────────────────
    const expectedProfit = Math.abs(target - entry) * qty;
    const expectedCost   = calcTradingCosts(action, entry, target, qty);
    if (expectedProfit <= expectedCost) {
      console.log(`[SignalEngine] ${stock.symbol} ${action} rejected | reason=cost-too-high | profit=₹${expectedProfit.toFixed(0)} cost=₹${expectedCost.toFixed(0)} qty=${qty}`);
      continue;
    }

    // ── Store as pending — await next scan cycle for confirmation ──────────
    _pendingSignal[stock.symbol] = { action, score };
    console.log(`[SignalEngine] ⏳ ${action} ${stock.symbol} score=${score} | RSI=${rsi ?? 'N/A'} | price=₹${stock.price} — awaiting ${action === 'BUY' ? 'bullish' : 'bearish'} confirmation candle`);
    log('SIGNAL', 'Signal pending', { symbol: stock.symbol, action, score, rsi, price: stock.price });
  }

  return signals.sort((a, b) => b.confidence - a.confidence);
}

module.exports = { generateSignals };

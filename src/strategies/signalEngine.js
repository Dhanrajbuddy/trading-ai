'use strict';

/**
 * Signal Engine — Intraday NSE Strategy
 *
 * Entry conditions (BUY):  Price > EMA20, RSI > 55, bullish candle, volume >= 1.5x
 * Entry conditions (SELL): Price < EMA20, RSI < 45, bearish candle, volume >= 1.5x
 * Skip: RSI 45–55 (neutral zone — no trade)
 * SL:     fixed 0.3% from entry
 * Target: fixed 1.2% from entry  (4:1 risk/reward)
 * Window: 9:30 AM – 3:00 PM IST (no new entries after 3 PM — gives time to fill)
 * Max 3 trades per day per symbol (increased from 1 to capture more opportunities)
 */

const { log } = require('../services/logger');
const { sendMarketClosedAlert } = require('../alerts/telegramAlert');
const { calculatePositionSize, getCapital } = require('./riskManager');

// ─── Config ───────────────────────────────────────────────────────────────────

const MIN_CONFIDENCE    = 65;             // minimum score — emits MEDIUM+ signals only (was 50)
const RSI_PERIOD        = 14;
const VOLUME_SPIKE_MIN  = 1.5;           // minimum volume multiplier for entry
const SL_PCT            = 0.3;           // 0.3% fixed stop loss
const TARGET_PCT        = 1.2;           // 1.2% fixed target → 4:1 R:R
// Capital allocation — reads CAPITAL env var via riskManager (default ₹20,000 for testing)
const MAX_CAPITAL_PER_TRADE_PCT = 0.80;  // deploy at most 80% of capital in a single trade
const MAX_CAPITAL_DAILY_MULT    = 2.5;   // total daily budget = capital × 2.5 (MIS leverage headroom)
const PRICE_HISTORY_MAX = 60;            // rolling window per symbol
const COOLDOWN_MS       = 10 * 60 * 1000; // 10-minute repeat-signal block (reduced from 15)
const MAX_TRADES_PER_DAY = 3;            // max signals per symbol per day (increased from 1)

// Trading window (IST): 9:30 AM – 3:00 PM (cutoff at 3 PM for safe fills)
const WINDOW_START_MINS  = 9 * 60 + 30;  // 570 = 9:30 AM
const ENTRY_CUTOFF_MINS  = 15 * 60 + 0;  // 900 = 3:00 PM

// ─── Per-run in-memory state ──────────────────────────────────────────────────

const _priceHistory   = {};  // symbol → number[]  (oldest-first)
const _lastSignalTime = {};  // symbol → epoch ms
const _tradesToday    = {};  // symbol → { date: 'YYYY-MM-DD', count: number }
const _prevCandle     = {};  // symbol → { high, low } from previous scan cycle
const _pendingSignal  = {};  // symbol → { action, signalPrice, score } awaiting next-scan confirmation
const _tickCount      = {};  // symbol → number of real LTP ticks observed (warmup guard)
const _capitalState   = { date: '', committed: 0 }; // total ₹ deployed in confirmed signals today

// Minimum real LTP ticks before RSI is trusted (5s scan → 30 ticks = 2.5 min warmup per symbol)
const WARMUP_TICKS = 30;

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
    _tickCount[symbol] = 0;
  }
  _priceHistory[symbol].push(price);
  _tickCount[symbol] = (_tickCount[symbol] || 0) + 1;
  if (_priceHistory[symbol].length > PRICE_HISTORY_MAX) {
    _priceHistory[symbol].shift();
  }
}

/** Reset daily capital tracking on new trading day. */
function resetCapitalDay() {
  const today = getTodayIST();
  if (_capitalState.date !== today) {
    _capitalState.date      = today;
    _capitalState.committed = 0;
  }
}

/**
 * Returns true if there is capital budget remaining to emit one more signal.
 * Daily budget = CAPITAL × MAX_CAPITAL_DAILY_MULT
 * Example: ₹20k capital × 2.5 = ₹50k/day max deployed across all signals.
 */
function hasCapitalHeadroom(positionValue) {
  resetCapitalDay();
  const budget = getCapital() * MAX_CAPITAL_DAILY_MULT;
  return (_capitalState.committed + positionValue) <= budget;
}

/** Record capital committed to an emitted signal. */
function commitCapital(positionValue) {
  resetCapitalDay();
  _capitalState.committed += positionValue;
  const budget = getCapital() * MAX_CAPITAL_DAILY_MULT;
  console.log(`[SignalEngine] 💰 Capital committed: ₹${positionValue.toFixed(0)} | Day total: ₹${_capitalState.committed.toFixed(0)} / ₹${budget.toFixed(0)}`);
}

/** True once enough real LTP ticks have been observed for RSI to be meaningful */
function isWarmedUp(symbol) {
  return (_tickCount[symbol] || 0) >= WARMUP_TICKS;
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
    const reason = (day === 0 || day === 6) ? 'Weekend — market closed' : 'Outside trading window (9:30–15:00 IST)';
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
        // Position sizing: 1% risk rule from riskManager, capped at 80% of capital per trade
        const _risk      = calculatePositionSize(pEntry, pSl, pTarget);
        const _capLimit  = Math.floor(getCapital() * MAX_CAPITAL_PER_TRADE_PCT / pEntry);
        const pQty       = Math.min(_risk.positionSize, _capLimit);
        if (pQty > 0) {
          const pExpProfit   = Math.abs(pTarget - pEntry) * pQty;
          const pExpCost     = calcTradingCosts(pending.action, pEntry, pTarget, pQty);
          const pPositionVal = parseFloat((pEntry * pQty).toFixed(2));
          if (pExpProfit > pExpCost && hasCapitalHeadroom(pPositionVal)) {
            commitCapital(pPositionVal);
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
              positionSize:     pQty,   // required by autoTrader + orderService
              positionValue:    pPositionVal,
              capitalDeployed:  pPositionVal,
              riskAmount:       parseFloat((Math.abs(pEntry - pSl) * pQty).toFixed(2)),
              expectedProfit:   parseFloat(pExpProfit.toFixed(2)),
              expectedCost:     parseFloat(pExpCost.toFixed(2)),
              reasons:          [`Confirmed: price ₹${pEntry} ${pending.action === 'BUY' ? '>' : '<'} signal price ₹${pending.signalPrice ?? '?'}`],
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

    // ── Warmup guard: skip until RSI has 30+ real ticks of data (~2.5 min) ───
    // Prevents cold-start flooding where seeded prevClose values produce fake RSI.
    if (!isWarmedUp(stock.symbol)) {
      const remaining = WARMUP_TICKS - (_tickCount[stock.symbol] || 0);
      if (remaining % 10 === 0) {
        console.log(`[SignalEngine] ⏳ ${stock.symbol} warming up (${remaining} ticks remaining)`);
      }
      continue;
    }

    // Capture current candle data — use dayHigh/dayLow as the range proxy
    // (Zerodha LTP quotes provide dayHigh/dayLow; stock.high/low are aliases)
    const candleHigh = stock.high ?? stock.dayHigh ?? stock.price;
    const candleLow  = stock.low  ?? stock.dayLow  ?? stock.price;
    const prev       = _prevCandle[stock.symbol] ?? null;
    _prevCandle[stock.symbol] = { high: candleHigh, low: candleLow };

    // ── Avoid strictly sideways stocks (day range < 0.3% — near flatline) ──
    // Uses dayHigh/dayLow range, so this only fires on truly dead stocks.
    if (candleHigh > 0 && (candleHigh - candleLow) / stock.price < 0.003) continue;

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

    // ── Position sizing: 1% risk rule via riskManager, capped at 80% of capital ──
    const _riskCalc  = calculatePositionSize(entry, sl, target);
    const _capLimit  = Math.floor(getCapital() * MAX_CAPITAL_PER_TRADE_PCT / entry);
    const qty        = Math.min(_riskCalc.positionSize, _capLimit);
    if (qty <= 0) continue;

    // ── Cost viability filter ───────────────────────────────────────────────
    const expectedProfit = Math.abs(target - entry) * qty;
    const expectedCost   = calcTradingCosts(action, entry, target, qty);
    if (expectedProfit <= expectedCost) {
      console.log(`[SignalEngine] ${stock.symbol} ${action} rejected | reason=cost-too-high | profit=₹${expectedProfit.toFixed(0)} cost=₹${expectedCost.toFixed(0)} qty=${qty}`);
      continue;
    }

    // ── Store as pending — await next scan cycle for confirmation ──────────
    _pendingSignal[stock.symbol] = { action, score, signalPrice: stock.price };
    console.log(`[SignalEngine] ⏳ ${action} ${stock.symbol} score=${score} | RSI=${rsi ?? 'N/A'} | price=₹${stock.price} — awaiting ${action === 'BUY' ? 'bullish' : 'bearish'} confirmation candle`);
    log('SIGNAL', 'Signal pending', { symbol: stock.symbol, action, score, rsi, price: stock.price });
  }

  return signals.sort((a, b) => b.confidence - a.confidence);
}

module.exports = { generateSignals };

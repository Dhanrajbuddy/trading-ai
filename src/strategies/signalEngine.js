'use strict';

/**
 * Signal Engine — Opening Range Breakout (ORB) Strategy on 15-min candles
 *
 * Strategy (validated by 60-day backtest on real Zerodha NSE data):
 *   - ORB window:   first 2 × 15-min candles (9:15–9:45 AM IST)
 *   - Signal:       price closes above/below ORB high/low + 0.10% buffer, with volume spike
 *   - RSI filter:   45–72 for BUY, 28–55 for SELL (not at extremes = room to run)
 *   - SL:           0.5% fixed below/above entry
 *   - Target:       2 × ORB range (dynamic); min 1.0% fallback
 *   - Focus stocks: BAJFINANCE, BAJAJFINSV, TCS (best performers, 42-50% WR)
 *   - Max 2 trades/day/symbol, 30-min cooldown
 *
 * Backtest result (60d real data): +₹231 net | 46.7% WR | 30 trades
 */

const { log } = require('../services/logger');
const { sendMarketClosedAlert } = require('../alerts/telegramAlert');
const { calculatePositionSize, getCapital } = require('./riskManager');

// ─── ORB Config (mirrors backtestEngine.js constants) ────────────────────────

const MIN_CONFIDENCE      = 60;
const VOLUME_SPIKE_MIN    = 1.5;
const SL_PCT              = 0.5;
const TARGET_MULT         = 2.0;    // 2× ORB range as target
const TARGET_PCT_FALLBACK = 1.0;    // fallback if ORB range is tiny
const ORB_CANDLES         = 2;      // first 2 × 15-min candles (30 min) form the ORB
const ORB_BUFFER_PCT      = 0.25;   // 0.25% above/below ORB to filter false breakouts (was 0.10%)
const CANDLE_MINS_15      = 15;     // 15-minute candles
const RSI_PERIOD          = 14;
const MAX_CAPITAL_PER_TRADE_PCT = 0.80;
const MAX_CAPITAL_DAILY_MULT    = 2.5;
const MAX_DAILY_RISK_PCT        = 0.020;
const MAX_TRADES_PER_DAY        = 2;
const COOLDOWN_MS               = 30 * 60 * 1000;  // 30-min cooldown

// Trading window (IST)
const WINDOW_START_MINS  = 9 * 60 + 30;   // 9:30 AM — after ORB established
const ENTRY_CUTOFF_MINS  = 14 * 60 + 30;  // 2:30 PM — no new entries after this
const CLOSE_ALL_MINS     = 15 * 60 + 15;  // 3:15 PM Zerodha auto-squareoff

// ─── Per-symbol in-memory state ───────────────────────────────────────────────

const _lastSignalTime = {};   // symbol → epoch ms
const _tradesToday    = {};   // symbol → { date, count }
const _capitalState   = { date: '', committed: 0 };
const _dailyRisk      = { date: '', committed: 0 };

// 15-min candle state
const _candle15State   = {};  // symbol → { windowMs, open, high, low, close, volume }
const _candle15History = {};  // symbol → [{ open, high, low, close, volume }, ...] closed candles

// ORB state (reset each day OR when data source changes)
const _orbState = {};  // symbol → { high, low, established, day, source }
let   _lastDataSource = null;  // track source so we can detect mock→zerodha switch

// VWAP state (reset each day)
const _vwapState = {}; // symbol → { accum, vol, day }



// ─── Helpers ──────────────────────────────────────────────────────────────────

function isWithinTradingWindow() {
  const ist  = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const day  = ist.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= WINDOW_START_MINS && mins <= ENTRY_CUTOFF_MINS;
}

function getCurrentMinsIST() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
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

// ─── 15-Minute Candle Builder ─────────────────────────────────────────────────
//
// Aligns to UTC multiples of 15-min (e.g. 3:45, 4:00 UTC = 9:15, 9:30 IST).
// When a new 15-min window starts, the previous candle is saved to _candle15History.
//
function update15MinCandle(symbol, price, volume, source) {
  const windowMs = Math.floor(Date.now() / (CANDLE_MINS_15 * 60_000)) * (CANDLE_MINS_15 * 60_000);
  const state    = _candle15State[symbol];

  if (!state || state.windowMs !== windowMs) {
    if (state) {
      // Close previous 15-min candle
      if (!_candle15History[symbol]) _candle15History[symbol] = [];
      _candle15History[symbol].push({ ...state });
      if (_candle15History[symbol].length > 30) _candle15History[symbol].shift();

      // Update ORB if not yet established (first ORB_CANDLES candles form the range)
      const today = getTodayIST();
      // Stamp source on ORB if not already set
      if (_orbState[symbol] && !_orbState[symbol].source) {
        _orbState[symbol].source = source || 'unknown';
      }
      const orb = _orbState[symbol];
      if (orb && !orb.established) {
        orb.high = Math.max(orb.high, state.high);
        orb.low  = Math.min(orb.low,  state.low);
        const todayCount = _candle15History[symbol].length;
        if (todayCount >= ORB_CANDLES) {
          const orbRange = orb.high - orb.low;
          const orbRangePct = (orbRange / state.close) * 100;
          // Sanity guard: NSE large-cap 30-min ORB is always 0.1–5%. Anything larger
          // means corrupted state (e.g. candle built from mock-data prices). Reject.
          if (orbRangePct > 5.0) {
            console.log(`[SignalEngine] ⛔ ${symbol} ORB rejected — range ${orbRangePct.toFixed(1)}% is implausible (likely mock-data corruption). Waiting for a valid ORB.`);
            log('WARN', `ORB rejected for ${symbol}`, { orbHigh: orb.high, orbLow: orb.low, orbRangePct: orbRangePct.toFixed(2) });
            // Force full reset so fresh candles rebuild a valid ORB
            _candle15History[symbol] = [];
            _candle15State[symbol]   = null;
            _orbState[symbol]        = { high: -Infinity, low: Infinity, established: false, day: orb.day, source: orb.source };
          } else {
            orb.established = true;
            console.log(`[SignalEngine] 📊 ${symbol} ORB established — High=₹${orb.high.toFixed(2)} Low=₹${orb.low.toFixed(2)} Range=${orbRangePct.toFixed(2)}% source=${orb.source}`);
            log('INFO', `ORB established for ${symbol}`, { orbHigh: orb.high, orbLow: orb.low, orbRangePct: orbRangePct.toFixed(2), source: orb.source });
          }
        }
      }
    }  // end if (state)
    _candle15State[symbol] = { windowMs, open: price, high: price, low: price, close: price, volume: volume || 0 };
  } else {
    state.high    = Math.max(state.high, price);
    state.low     = Math.min(state.low, price);
    state.close   = price;
    state.volume  = (state.volume || 0) + (volume || 0);
  }
}

/**
 * Reset 15-min state and ORB.
 * Triggers on: (a) new calendar day, or (b) data source changed (mock → zerodha).
 * Prevents stale mock-data ORB from being used with live prices.
 */
function resetDayState(symbol, currentSource) {
  const today     = getTodayIST();
  const orb       = _orbState[symbol];
  const newDay    = !orb || orb.day !== today;
  const srcChange = orb && orb.source && currentSource && orb.source !== currentSource;

  if (!newDay && !srcChange) return; // nothing to reset

  if (srcChange) {
    console.log(`[SignalEngine] ⚠️  ${symbol} data source changed ${orb.source} → ${currentSource} — ORB reset`);
    log('INFO', `ORB reset: data source changed for ${symbol}`, { from: orb.source, to: currentSource });
  }

  _candle15History[symbol] = [];
  _candle15State[symbol]   = null;
  _orbState[symbol]        = { high: -Infinity, low: Infinity, established: false, day: today, source: currentSource };
  _vwapState[symbol]       = { accum: 0, vol: 0, day: today };
  if (newDay) console.log(`[SignalEngine] 🔄 ${symbol} day state reset for ${today}`);
}

/** Returns RSI computed on closed 15-min candle closes, null if too few candles. */
function get15MinRSI(symbol) {
  const history = _candle15History[symbol] || [];
  const current = _candle15State[symbol];
  const closes  = [...history.map(c => c.close), ...(current ? [current.close] : [])];
  return computeRSI(closes);
}

/** Returns current VWAP for the day. */
function getDayVWAP(symbol, typicalPrice, volume) {
  const today = getTodayIST();
  if (!_vwapState[symbol] || _vwapState[symbol].day !== today) {
    _vwapState[symbol] = { accum: 0, vol: 0, day: today };
  }
  const v = _vwapState[symbol];
  if (volume > 0) {
    v.accum += typicalPrice * volume;
    v.vol   += volume;
  }
  return v.vol > 0 ? v.accum / v.vol : null;
}


// ─── Daily Risk / Capital Tracking ───────────────────────────────────────────

function resetDailyRisk() {
  const today = getTodayIST();
  if (_dailyRisk.date !== today) { _dailyRisk.date = today; _dailyRisk.committed = 0; }
}
function hasDailyRiskHeadroom(riskAmount) {
  resetDailyRisk();
  return (_dailyRisk.committed + riskAmount) <= getCapital() * MAX_DAILY_RISK_PCT;
}
function commitDailyRisk(riskAmount) {
  resetDailyRisk();
  _dailyRisk.committed += riskAmount;
  const cap = getCapital() * MAX_DAILY_RISK_PCT;
  console.log(`[SignalEngine] 🛡️  Daily risk: ₹${_dailyRisk.committed.toFixed(0)} / ₹${cap.toFixed(0)} limit`);
}
function resetCapitalDay() {
  const today = getTodayIST();
  if (_capitalState.date !== today) { _capitalState.date = today; _capitalState.committed = 0; }
}
function hasCapitalHeadroom(positionValue) {
  resetCapitalDay();
  return (_capitalState.committed + positionValue) <= getCapital() * MAX_CAPITAL_DAILY_MULT;
}
function commitCapital(positionValue) {
  resetCapitalDay();
  _capitalState.committed += positionValue;
  const budget = getCapital() * MAX_CAPITAL_DAILY_MULT;
  console.log(`[SignalEngine] 💰 Capital committed: ₹${positionValue.toFixed(0)} | Day total: ₹${_capitalState.committed.toFixed(0)} / ₹${budget.toFixed(0)}`);
}

// ─── RSI ─────────────────────────────────────────────────────────────────────

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

// ─── Signal scoring ──────────────────────────────────────────────────────────
//   Base: 40 (all ORB gates passed)
//   +20 RSI quality (55–72 BUY | 28–45 SELL = room to run)
//   +20 Volume (≥2× = strong; ≥3× = very strong)
//   +20 VWAP alignment
function scoreSignal(action, stock, rsi) {
  let score = 40;
  const reasons = [`ORB ${action === 'BUY' ? 'breakout above' : 'breakdown below'} range + buffer`];

  // RSI quality
  if (rsi !== null) {
    if (action === 'BUY' && rsi >= 60 && rsi <= 72) {
      score += 20;
      reasons.push(`RSI ${rsi} — bullish momentum, not overbought`);
    } else if (action === 'BUY' && rsi >= 50) {
      score += 10;
      reasons.push(`RSI ${rsi} — moderate bullish bias`);
    } else if (action === 'SELL' && rsi >= 28 && rsi <= 40) {
      score += 20;
      reasons.push(`RSI ${rsi} — bearish momentum, not oversold`);
    } else if (action === 'SELL' && rsi <= 50) {
      score += 10;
      reasons.push(`RSI ${rsi} — moderate bearish bias`);
    }
  }

  // Volume quality
  const vm = stock.volumeMultiplier;
  if (vm != null) {
    if (vm >= 3.0)      { score += 20; reasons.push(`Volume ${vm.toFixed(1)}x — strong institutional`); }
    else if (vm >= 2.0) { score += 15; reasons.push(`Volume ${vm.toFixed(1)}x — good confirmation`); }
    else if (vm >= 1.5) { score += 8;  reasons.push(`Volume ${vm.toFixed(1)}x — spike confirmed`); }
  }

  // VWAP alignment
  if (stock.vwap != null) {
    const aligned = (action === 'BUY' && stock.price > stock.vwap) ||
                    (action === 'SELL' && stock.price < stock.vwap);
    if (aligned) {
      score += 20;
      reasons.push(`Price ${action === 'BUY' ? 'above' : 'below'} VWAP ₹${stock.vwap.toFixed(2)}`);
    }
  }

  return { score: Math.min(score, 100), reasons };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Generate trading signals from a live market snapshot using ORB strategy.
 * @param {Array}  stocks   Market snapshot from marketScanner
 * @param {Object} scanData { topGainers, volumeSpikes, breakouts, vwapBreakouts }
 * @returns {Array<Object>} Signals sorted by confidence desc, empty [] outside window
 */
function generateSignals(stocks, scanData) {
  const { volumeSpikes } = scanData;
  const nowMins = getCurrentMinsIST();

  if (!isWithinTradingWindow()) {
    const ist    = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const day    = ist.getUTCDay();
    const reason = (day === 0 || day === 6)
      ? 'Weekend — market closed'
      : 'Outside trading window (9:30–14:30 IST)';
    console.log(`[SignalEngine] ${reason}. No signals.`);
    log('INFO', `⛔ Market Closed — ${reason}.`);
    sendMarketClosedAlert();
    return [];
  }

  const spikeSymbols = new Set((volumeSpikes || []).map((s) => s.symbol));
  const signals      = [];

  for (const stock of stocks) {
    const sym   = stock.symbol;
    const price = stock.price;
    const vol   = stock.volume || 0;

    // Detect data source (zerodha / mock). Reset ORB if source changed since last scan.
    const currentSource = stock.source || 'unknown';
    if (_lastDataSource !== null && _lastDataSource !== currentSource) {
      // Source switched (e.g. mock → zerodha) — force-reset ALL ORB states this cycle
      for (const s of Object.keys(_orbState)) {
        if (_orbState[s]) _orbState[s].source = null; // triggers srcChange in resetDayState
      }
    }
    _lastDataSource = currentSource;

    // Reset state on new trading day or data-source switch
    resetDayState(sym, currentSource);

    // Build 15-min candle from this tick
    update15MinCandle(sym, price, vol, currentSource);

    // ── Gates ────────────────────────────────────────────────────────────────
    if (isMaxTradesReached(sym)) continue;
    if (isOnCooldown(sym)) {
      const minsLeft = Math.ceil((COOLDOWN_MS - (Date.now() - _lastSignalTime[sym])) / 60_000);
      console.log(`[SignalEngine] ${sym} cooldown (${minsLeft} min left)`);
      continue;
    }

    // Wait for ORB to be established (first 2 × 15-min candles completed)
    const orb = _orbState[sym];
    if (!orb || !orb.established) {
      const candleCount = (_candle15History[sym] || []).length;
      if (candleCount % 1 === 0) {
        console.log(`[SignalEngine] ⏳ ${sym} ORB pending — ${candleCount}/${ORB_CANDLES} candles built`);
      }
      continue;
    }

    // No new entries after cutoff
    if (nowMins >= CLOSE_ALL_MINS) continue;

    // ── ORB breakout entry conditions ────────────────────────────────────────
    const orbRange    = orb.high - orb.low;
    const orbBufHigh  = orb.high * (1 + ORB_BUFFER_PCT / 100);
    const orbBufLow   = orb.low  * (1 - ORB_BUFFER_PCT / 100);

    const currentCandle = _candle15State[sym];
    const bullishCandle = currentCandle && currentCandle.close > currentCandle.open;
    const bearishCandle = currentCandle && currentCandle.close < currentCandle.open;

    const hasVolumeSpike = spikeSymbols.has(sym) ||
                           (stock.volumeMultiplier != null && stock.volumeMultiplier >= VOLUME_SPIKE_MIN);

    const rsi = get15MinRSI(sym);
    const rsiOkBuy  = rsi === null || (rsi >= 45 && rsi <= 72);
    const rsiOkSell = rsi === null || (rsi >= 28 && rsi <= 55);

    // VWAP alignment: hard gate (not just a scoring factor).
    // For BUY: price must be ABOVE VWAP (stock trading above its intraday average)
    // For SELL: price must be BELOW VWAP (if price is recovering toward VWAP, skip)
    // Skip gate if VWAP not yet computed (early in the session)
    const vwapAbove = stock.vwap == null || price > stock.vwap;
    const vwapBelow = stock.vwap == null || price < stock.vwap;

    const isBuy  = price > orbBufHigh && bullishCandle && hasVolumeSpike && rsiOkBuy  && vwapAbove;
    const isSell = price < orbBufLow  && bearishCandle && hasVolumeSpike && rsiOkSell && vwapBelow;

    if (!isBuy && !isSell) {
      // Log why no signal (verbose only for debugging)
      if (process.env.SIGNAL_DEBUG === '1') {
        console.log(`[SignalEngine] ${sym} no signal — price=₹${price.toFixed(2)} orbH=₹${orbBufHigh.toFixed(2)} orbL=₹${orbBufLow.toFixed(2)} bullish=${bullishCandle} bear=${bearishCandle} volSpike=${hasVolumeSpike} RSI=${rsi}`);
      }
      continue;
    }

    const action = isBuy ? 'BUY' : 'SELL';

    // ── Score ────────────────────────────────────────────────────────────────
    const { score, reasons } = scoreSignal(action, stock, rsi);
    if (score < MIN_CONFIDENCE) {
      console.log(`[SignalEngine] ✗ ${sym} ${action} score=${score} < ${MIN_CONFIDENCE}`);
      continue;
    }

    // ── SL and dynamic target (2× ORB range) ─────────────────────────────────
    const entry = price;
    const sl    = action === 'BUY'
      ? parseFloat((entry * (1 - SL_PCT / 100)).toFixed(2))
      : parseFloat((entry * (1 + SL_PCT / 100)).toFixed(2));

    const orbRangePct   = (orbRange / entry) * 100;
    const targetPct     = Math.max(orbRangePct * TARGET_MULT, TARGET_PCT_FALLBACK);
    const target        = action === 'BUY'
      ? parseFloat((entry * (1 + targetPct / 100)).toFixed(2))
      : parseFloat((entry * (1 - targetPct / 100)).toFixed(2));

    // ── Position sizing ───────────────────────────────────────────────────────
    const _riskCalc  = calculatePositionSize(entry, sl, target);
    const _capLimit  = Math.floor(getCapital() * MAX_CAPITAL_PER_TRADE_PCT / entry);
    const qty        = Math.min(_riskCalc.positionSize, _capLimit);
    if (qty <= 0) continue;

    const positionValue  = parseFloat((entry * qty).toFixed(2));
    const riskAmount     = parseFloat((Math.abs(entry - sl) * qty).toFixed(2));
    const expectedProfit = parseFloat((Math.abs(target - entry) * qty).toFixed(2));
    const expectedCost   = calcTradingCosts(action, entry, target, qty);

    // ── Cost viability gate ───────────────────────────────────────────────────
    if (expectedProfit <= expectedCost) {
      console.log(`[SignalEngine] ✗ ${sym} ${action} cost-too-high | profit=₹${expectedProfit.toFixed(0)} cost=₹${expectedCost.toFixed(0)}`);
      continue;
    }

    // ── Capital / daily-risk gates ────────────────────────────────────────────
    if (!hasCapitalHeadroom(positionValue) || !hasDailyRiskHeadroom(riskAmount)) continue;

    // ── Emit signal ───────────────────────────────────────────────────────────
    commitCapital(positionValue);
    commitDailyRisk(riskAmount);
    markSignalTime(sym);

    console.log(
      `[SignalEngine] ✅ ${action} ${sym} | ORB ${orb.high.toFixed(2)}–${orb.low.toFixed(2)} | ` +
      `entry=₹${entry} SL=₹${sl} target=₹${target} (${targetPct.toFixed(2)}%) | ` +
      `qty=${qty} score=${score} RSI=${rsi ?? 'N/A'}`
    );
    log('SIGNAL', 'ORB signal', {
      symbol: sym, action, score, rsi,
      entry, sl, target, targetPct: parseFloat(targetPct.toFixed(2)),
      orbHigh: orb.high, orbLow: orb.low, orbRange: parseFloat(orbRange.toFixed(2)),
      qty, positionValue, riskAmount, expectedProfit, expectedCost,
    });

    signals.push({
      symbol:           sym,
      action,
      strength:         strengthLabel(score),
      confidence:       score,
      price:            entry,
      changePercent:    stock.changePercent,
      volume:           stock.volume,
      avgVolume:        stock.avgVolume,
      volumeMultiplier: stock.volumeMultiplier,
      vwap:             stock.vwap ?? null,
      rsi,
      entry,
      stopLoss:         sl,
      slType:           `fixed-${SL_PCT}%`,
      target,
      targetPct:        parseFloat(targetPct.toFixed(2)),
      orbHigh:          parseFloat(orb.high.toFixed(2)),
      orbLow:           parseFloat(orb.low.toFixed(2)),
      orbRange:         parseFloat(orbRange.toFixed(2)),
      qty,
      positionSize:     qty,
      positionValue,
      capitalDeployed:  positionValue,
      riskAmount,
      expectedProfit,
      expectedCost,
      reasons,
      source:           stock.source ?? 'live',
      timestamp:        stock.timestamp,
      confirmed:        true,
    });
  }

  return signals.sort((a, b) => b.confidence - a.confidence);
}


module.exports = { generateSignals };

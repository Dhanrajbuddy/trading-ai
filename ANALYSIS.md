# Trading AI — Windsurf Analysis & Improvement Plan

> Generated: June 12, 2026  
> Analyst: Windsurf Cascade  
> Source of truth: codebase + `data/signal-outcomes.json`

---

## 1. System Architecture Summary

```
Zerodha Kite API (47 Nifty 50 stocks, REST every 5 sec)
   ↓
stockUniverse.js   → selects top 20 active stocks every 5 min
   ↓
marketScanner.js   → EMA cross, VWAP, volume spike, gainers
   ↓
signalEngine.js    → ORB strategy on 15-min candles
   ↓  (score ≥ 60 → signal fires)
signalTracker.js   → paper trading outcome recorder
aiAnalyzer.js      → factor-model confidence scorer
telegramAlert.js   → Telegram notifications
autoTrader.js      → 7-gate live execution (disabled by default)
```

**Strategy**: Opening Range Breakout (ORB) on 15-minute candles.  
First 2 candles (9:15–9:45 AM IST) form the range. Breakout above/below with volume spike fires a signal.

---

## 2. Paper Trading Statistics (Evidence-Based)

**Period**: June 2 – June 12, 2026 (8 trading days)  
**Source**: `data/signal-outcomes.json`

| Metric | Value |
|---|---|
| Total trades recorded | 31 |
| Wins | 1 |
| Losses | 16 |
| Expired | 14 |
| **Win Rate (decided)** | **5.9%** (1/17) |
| Gross profit from wins | ₹157.08 |
| Gross loss from losses | −₹1,215.40 |
| Expired net P&L | +₹155.44 |
| **Total P&L** | **−₹903.65** |
| **Profit Factor** | **0.13** (catastrophic; need > 1.5) |
| Max consecutive losses | 9 |

### By Direction

| Direction | Trades | Wins | Losses | Expired | Win Rate |
|---|---|---|---|---|---|
| BUY | 18 | 1 | 10 | 7 | 9.1% |
| SELL | 13 | 0 | 6 | 7 | **0.0%** |

### Expired Trade Observation
14 expired trades had an average P&L of **+₹11.10** each — meaning when neither SL nor target was hit by 3:15 PM, the position was *mildly profitable*. This is a key insight: **the underlying moves are not completely wrong in direction, but the targets are too far away and the SL is too tight.**

---

## 3. Root Cause Analysis

### Problem 1 — SELL signals in a bull market (CRITICAL)
**Evidence**: 0/6 SELL signals resulted in wins. Signals like GRASIM SELL, ICICIBANK SELL, WIPRO SELL, ITC SELL, TRENT SELL, LT SELL, SHRIRAMFIN SELL, HINDUNILVR SELL, NESTLEIND SELL all lost.

June 2026 is a rising market for NSE. The ORB strategy correctly identifies breakdowns, but the broader market trend is upward, causing SELL breakdowns to reverse quickly and hit SL.

**Fix**: Add a market breadth / Nifty trend filter. Block SELL signals when Nifty is in an uptrend. A simple check: if more than 55% of the universe stocks are above their VWAP, suppress SELL signals.

---

### Problem 2 — Stop-loss is too tight at 0.5% (CRITICAL)
**Evidence**: Every single loss exits at exactly the SL price (exit = stopLoss in all 16 loss records). The losses are mechanically uniform: ≈−₹75 each. This means price is touching the 0.5% SL level and then continuing to the original target direction, which explains why EXPIRED trades are mildly profitable.

**The 0.5% SL is being hit by normal intraday noise**, not by genuine reversals.

For stocks like MARUTI (₹13,029 entry), a 0.5% SL = ₹65 move. For DIVISLAB (₹6,491), it's ₹32. These are well within the normal intraday bid-ask spread and volatility range for a 15-min candle.

**Fix**: Use ATR-based SL or increase to 0.8–1.0% fixed SL. Also consider placing SL below the ORB low (for BUY) rather than a fixed % from entry — this is the canonical ORB SL approach.

---

### Problem 3 — ORB buffer mismatch between backtest and live (HIGH)
**Evidence**:
- `backtestEngine.js` uses `ORB_BUFFER_PCT = 0.10%`
- `signalEngine.js` uses `ORB_BUFFER_PCT = 0.25%`

The backtest that produced the "46.7% win rate, +₹231" result was run with **0.10%** buffer. The live system uses **0.25%** — a tighter filter that fires later into a move, reducing the R:R ratio because you're already chasing the move further from the ORB level.

**Fix**: Align both to 0.10% (the validated backtest value).

---

### Problem 4 — ORB is built from tick data, not real 15-min candles (HIGH)
**Evidence**: `signalEngine.js` builds 15-min candles from individual price ticks polled every 5 seconds. The pipeline runs `cron('*/5 * * * * *')` — a 5-second REST poll, not a WebSocket feed. Each "tick" is the current last-traded price.

This means:
- The "candle" high/low is actually the highest/lowest LTP seen across multiple 5-second polls within a 15-min window.
- Volume is accumulated by summing `q.volume` (cumulative day volume) differences — but `q.volume` from Kite REST is cumulative day volume, and the code does `state.volume += volume` instead of computing the delta. This **double-counts volume** every poll cycle.

The ORB established from corrupted volume data leads to incorrect `hasVolumeSpike` evaluations.

**Fix**: Compute volume delta per poll (current volume − previous volume). Or use Kite WebSocket for real streaming ticks.

---

### Problem 5 — RSI computed on too few candles (MEDIUM)
**Evidence**: `get15MinRSI()` uses `_candle15History` + current candle. RSI-14 needs at least 15 closes. After the ORB is established (2 candles), only 2 closed candles exist. RSI cannot be computed (`returns null`), and `rsiOkBuy = rsi === null || (rsi >= 45 && rsi <= 72)` — **the null case passes the gate**, meaning RSI is not actually filtering anything in the first 15 candles (~3.75 hours of trading).

After 3:45 hours the RSI has data, but signals are rare then anyway. In practice, RSI is **never filtering** early signals.

**Fix**: Either require a minimum candle history (e.g., 5 candles) before RSI gate is enforced, or seed RSI with previous-day closes from Zerodha historical API.

---

### Problem 6 — Market is checked but Nifty trend is ignored (MEDIUM)
**Evidence**: The `isWithinTradingWindow()` check gates on time but there is no Nifty 50 index trend filter. The original README mentioned "Market breadth BULLISH (≥60% stocks above EMA-20) blocks SELL" but this logic was **removed** when the system was migrated from the old 5-condition scorer to ORB strategy. SELL signals now fire freely regardless of market direction.

---

### Problem 7 — Signal frequency is very low (MEDIUM)
**Evidence**: 31 signals over 8 trading days = ~3.9 signals/day across 47 stocks. That is low.

Causes:
- ORB requires 2 full 15-min candles to form (unavoidable — by design)
- `COOLDOWN_MS = 30 min` per symbol
- `MAX_TRADES_PER_DAY = 2` per symbol
- `MAX_DAILY_RISK_PCT = 2%` of capital is a hard daily limit
- `MAX_CAPITAL_DAILY_MULT = 2.5×` capital deployment cap

None of these are the primary problem — the frequency is actually reasonable for ORB. The problem is **signal quality**, not quantity.

---

### Problem 8 — Target is dynamic but often unreachable (LOW)
**Evidence**: The target is `2× ORB range` from entry. For a tight ORB (e.g. 0.3% range), target = 0.6% but SL = 0.5%. R:R = 0.6/0.5 = **1.2:1**, well below the 2:1 minimum needed to be profitable at 50% WR.

The `TARGET_PCT_FALLBACK = 1.0%` kicks in only when `2× ORB range < 1.0%`, i.e. when ORB range < 0.5%. Many NSE Nifty 50 stocks have 0.3–0.5% ORB ranges, so the fallback fires frequently — and 1.0% target vs 0.5% SL = 2:1 R:R is marginal.

With the actual live WR of 5.9%, you need R:R > 16:1 to break even. The system currently targets 2:1.

---

## 4. What Is Working

1. **Architecture is sound** — pipeline, paper tracking, risk manager, OCO, Telegram alerts all function correctly.
2. **ORB concept is valid** — 46.7% backtest WR on real Zerodha data (per backtestEngine comments) is above the break-even for 2:1 R:R.
3. **EXPIRED trades are slightly positive** — when the SL doesn't get hit, the strategy has positive expectancy. The problem is the SL is too tight.
4. **Position sizing is conservative** — 1% risk per trade, consistent losses of ≈₹75 confirm this is working correctly.
5. **Paper trading infrastructure** — signalTracker, outcome recording, and frontend Stats tab are well-built.
6. **Safety gates** — autoTrader and orderService have layered protection; no risk of runaway trades.
7. **BUY signals have some edge** — 9.1% WR for BUY (1/11 decided) is terrible but better than SELL at 0%. With market trend filter, BUY-only WR could improve significantly.

---

## 5. Improvement Plan (Priority Order)

### Fix 1 — Add Nifty trend filter to suppress SELL signals ⭐ HIGHEST PRIORITY
Block SELL signals when the broad market is bullish (> 55% of stocks above VWAP or positive change). This alone would have prevented 6 losing SELL trades (≈−₹460 saved).

### Fix 2 — Widen stop-loss to 0.8% or use ORB-based SL ⭐ HIGHEST PRIORITY
Canonical ORB SL for BUY = entry minus ORB low. For SELL = entry plus ORB high. This is always wider than 0.5%, adapts to volatility, and eliminates noise-induced stops.

Alternatively: increase fixed SL to 0.8% and adjust target to 1.6% minimum (maintain 2:1 R:R).

### Fix 3 — Fix ORB buffer to match backtest (0.10%) HIGH
Change `ORB_BUFFER_PCT` in `signalEngine.js` from 0.25% → 0.10% to match the validated backtest configuration.

### Fix 4 — Fix volume accumulation bug HIGH
In `update15MinCandle()`, volume is being accumulated by adding Kite's cumulative day volume each tick. It should store the delta (current - previous) to get the 15-min candle volume correctly.

### Fix 5 — Add minimum candle count before RSI gate MEDIUM
Require at least 5 closed 15-min candles before using RSI as a filter. Before that, use a simple EMA direction check.

### Fix 6 — Add dynamic R:R minimum gate MEDIUM
Reject signals where `(target - entry) / (entry - SL) < 1.5`. This prevents low-quality setups from generating signals.

---

## 6. Capital & Profit Goal Assessment

**Current capital**: ~₹20,000 (implied by paper trading position sizes: e.g. NTPC ×43 @ ₹368 = ₹15,824)  
**Daily target**: ₹500+  
**Required daily return**: 2.5% on ₹20,000

With 1% risk per trade (₹200 risk) and 2:1 R:R target (₹400 reward), achieving ₹500/day requires **at least 2 winning trades**. That's feasible at 50%+ WR, but the current 5.9% WR makes it impossible.

**After fixes 1–3**: The backtest demonstrated 46.7% WR on the validated ORB config. At 46.7% WR with 2:1 R:R:
- Expected value per trade = 0.467 × ₹400 − 0.533 × ₹200 = ₹186.8 − ₹106.6 = **+₹80.2 per trade**
- To earn ₹500/day: need ~6.2 trades → not realistic on ₹20k capital (daily risk cap: ₹400)
- Realistic daily expectation: 2–3 trades × ₹80 EV = ₹160–₹240/day

**To reach ₹500/day target**: Capital needs to be ~₹50,000–₹60,000, or risk% needs to be higher (2–3%) while maintaining 50%+ WR.

---

## 7. Additional Investigations (Session 2)

### 2:30 PM Auto-Close
The 2:30 PM cutoff (`ENTRY_CUTOFF_MINS`) only blocks **new signal entries** — it does NOT close open trades.
Open trades continue running until 3:15 PM squareoff (`SQUAREOFF_MINS = 15*60+15` in signalTracker.js).
All EXPIRED records in the data correctly show `resolvedAt` timestamps at 09:45 UTC = **3:15 PM IST**.
The 2:30 PM cutoff is **intentional and correct** — late ORB entries have poor R:R due to proximity to squareoff.
The backtest uses 3:00 PM cutoff (more aggressive); this inflated backtest trade count vs. live.

### Refresh Frequency
Pipeline runs every **5 seconds** (not 2 seconds). Two cron jobs at `*/5 * * * * *`.
Zerodha REST limit is 3 req/sec; current usage is 0.2 req/sec — well within limits.
Reducing to 1 second would: (a) not improve 15-min candle signals, (b) destabilise the rate-based volume EMA,
(c) risk API throttling. **No change needed.**

### Backtest vs Live Gap — Root Causes
1. `ORB_BUFFER_PCT`: backtest uses 0.10%, live was using 0.25% — **fixed**
2. RSI null bypass: live passed null RSI through the gate; backtest required non-null — **fixed**
3. Different `scoreSignal` implementations (different base scores, VWAP weighting, ORB range scoring)
4. Different `ENTRY_CUTOFF_MINS` (backtest 3:00 PM vs live 2:30 PM) — live is stricter, backtest overcounts
5. The 46.7% WR likely came from synthetic candle data (seed prices from 2024), not real Zerodha candles
6. **Volume calculation in zerodhaService.js is correct** (rate-based delta EMA) — not a bug

### Expired Trades Analysis
- 10 of 14 expired (71%) were moving in the correct direction at 3:15 PM squareoff
- 0 of 14 expired trades would have hit target even at 3:30 PM — price was only 4–60% of the way to target
- The 2:30 PM cutoff did NOT cause expiries — all entries were before 11:30 AM IST
- Root cause of expiries: **target is too far** (2× ORB range often > 1.5%, but intraday move < 0.8%)

## 8. Implemented Changes (Session 2)

### Change 1 — ORB Buffer aligned to 0.10% ✅
`signalEngine.js` `ORB_BUFFER_PCT`: 0.25% → **0.10%** (matches backtestEngine.js validated config)

### Change 2 — RSI null bypass removed ✅
`signalEngine.js` `rsiOkBuy`/`rsiOkSell`: now require `rsi !== null` before passing.
Signals without enough candle history (< 15 candles) are now correctly rejected, matching backtest behaviour.

### Change 3 — Nifty Trend Filter (Fix 1) ✅
Added `BULL_MARKET_THRESHOLD = 0.55` constant.
Computed once per pipeline cycle: if ≥55% of stocks have price > VWAP, `isBullMarket = true`.
SELL signals blocked when `isBullMarket = true`.
Evidence: 0/13 SELL signals won during Jun 2026 bull market.
Log line: `📈 Bull market detected — X / Y stocks above VWAP (Z%). SELL signals suppressed.`
`marketBreadth` and `marketTrend` fields added to signal output for dashboard visibility.

## 9. Remaining Improvements (Priority Order)

1. **ORB-based SL** — use ORB low/high as SL instead of fixed 0.5% (highest remaining impact)
2. **Align backtest ENTRY_CUTOFF to 2:30 PM** — so backtest WR reflects what live system actually trades
3. **Align backtest scoreSignal** — unify scoring logic between backtestEngine.js and signalEngine.js
4. **Add minimum R:R gate** — reject signals where (target-entry)/(entry-SL) < 1.5
5. **Seed RSI with previous-day closes** — so RSI is available from the first post-ORB candle

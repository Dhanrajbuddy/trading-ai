'use strict';

/**
 * Tests for Telegram Stars paid-signal system.
 * Run: node tests/testPaidSignals.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

process.env.TELEGRAM_SIGNAL_PRICE_STARS = '200';
process.env.TELEGRAM_PAYMENT_CURRENCY = 'XTR';

const mockSignal = {
  symbol: 'INFY', action: 'BUY', confidence: 72, price: 1052.6,
  changePercent: -0.38, volume: 2945362, avgVolume: 853728,
  volumeMultiplier: 3.5, vwap: 1051.01, rsi: 59.8,
  entry: 1052.6, stopLoss: 1047.3, target: 1063.2, targetPct: 1.0,
  qty: 10, reasons: ['ORB breakout above range + buffer', 'RSI 59.8 — moderate momentum',
    'Volume 3.5x — institutional', 'Price above VWAP ₹1051.01'],
  timestamp: Date.now(),
};
const mockAnalysis = { confidence: 72, reason: 'baseline (1 trades observed)', source: 'factor-model' };

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}
async function asyncTest(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const DATA_FILE = path.join(dataDir, 'paid-signals.json');
if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);

const store = require('../src/telegram/signalStore');
const { formatPreview, formatFullSignal } = require('../src/telegram/previewFormatter');
const { verifyPayment, processSuccessfulPayment, buildInvoice } = require('../src/telegram/paymentService');

async function run() {
  console.log('\n🧪 Paid Signal Tests\n');

  console.log('── Preview Generation ──');
  test('preview exposes symbol and action', () => {
    const p = formatPreview(mockSignal, mockAnalysis, 200);
    assert(p.includes('INFY'));
    assert(p.includes('BUY'));
  });
  test('preview exposes AI confidence', () => {
    const p = formatPreview(mockSignal, mockAnalysis, 200);
    assert(p.includes('72%'));
  });
  test('preview hides entry price', () => {
    const p = formatPreview(mockSignal, mockAnalysis, 200);
    assert(!p.includes('1052.6'), 'Preview must not expose entry price');
  });
  test('preview hides stop loss', () => {
    const p = formatPreview(mockSignal, mockAnalysis, 200);
    assert(!p.includes('1047.3'), 'Preview must not expose SL');
  });
  test('preview hides target', () => {
    const p = formatPreview(mockSignal, mockAnalysis, 200);
    assert(!p.includes('1063.2'), 'Preview must not expose target');
  });
  test('preview shows Stars price', () => {
    const p = formatPreview(mockSignal, mockAnalysis, 200);
    assert(p.includes('200'));
    assert(p.includes('⭐'));
  });
  test('preview preserves timestamp', () => {
    const p = formatPreview(mockSignal, mockAnalysis, 200);
    assert(p.includes('IST'));
  });

  console.log('── Full Signal ──');
  test('full signal includes entry', () => {
    const f = formatFullSignal(mockSignal, mockAnalysis);
    assert(f.includes('1052.6'));
  });
  test('full signal includes SL and target', () => {
    const f = formatFullSignal(mockSignal, mockAnalysis);
    assert(f.includes('1047.3'));
    assert(f.includes('1063.2'));
  });

  console.log('── Signal Store ──');
  let signalId;
  test('createSignalRecord returns UUID', () => {
    signalId = store.createSignalRecord(mockSignal, mockAnalysis, 200);
    assert(signalId && signalId.length === 36, 'Should return UUID');
  });
  test('getSignal returns the record', () => {
    const sig = store.getSignal(signalId);
    assert(sig);
    assert(sig.symbol === 'INFY');
  });
  test('getFullSignal returns parsed payload', () => {
    const full = store.getFullSignal(signalId);
    assert(full);
    assert(full.signal.symbol === 'INFY');
    assert(full.analysis.confidence === 72);
  });
  test('hasPurchased returns false for new user', () => {
    assert(!store.hasPurchased(signalId, 12345));
  });

  console.log('── Payment Verification ──');
  test('valid payment passes verification', () => {
    const r = verifyPayment({
      invoice_payload: `unlock_signal:${signalId}`,
      currency: 'XTR',
      total_amount: 200,
      telegram_payment_charge_id: 'charge_001',
    });
    assert(r.valid);
    assert(r.signalId === signalId);
  });
  test('wrong currency rejected', () => {
    const r = verifyPayment({
      invoice_payload: `unlock_signal:${signalId}`,
      currency: 'USD',
      total_amount: 200,
      telegram_payment_charge_id: 'charge_002',
    });
    assert(!r.valid);
    assert(r.error.includes('currency'));
  });
  test('wrong amount rejected', () => {
    const r = verifyPayment({
      invoice_payload: `unlock_signal:${signalId}`,
      currency: 'XTR',
      total_amount: 100,
      telegram_payment_charge_id: 'charge_003',
    });
    assert(!r.valid);
    assert(r.error.includes('amount'));
  });
  test('invalid signal ID rejected', () => {
    const r = verifyPayment({
      invoice_payload: 'unlock_signal:nonexistent-uuid',
      currency: 'XTR',
      total_amount: 200,
      telegram_payment_charge_id: 'charge_004',
    });
    assert(!r.valid);
    assert(r.error.includes('not found'));
  });
  test('unexpected payload rejected', () => {
    const r = verifyPayment({
      invoice_payload: 'something_else',
      currency: 'XTR',
      total_amount: 200,
      telegram_payment_charge_id: 'charge_005',
    });
    assert(!r.valid);
  });

  console.log('── Payment Processing ──');
  let deliveredText = null;
  const mockSendFn = async (chatId, text) => { deliveredText = text; };

  await asyncTest('successful payment delivers full signal', async () => {
    deliveredText = null;
    const r = await processSuccessfulPayment(
      { invoice_payload: `unlock_signal:${signalId}`, currency: 'XTR',
        total_amount: 200, telegram_payment_charge_id: 'charge_010' },
      12345, 'testuser', mockSendFn
    );
    assert(r.delivered);
    assert(!r.duplicate);
    assert(deliveredText && deliveredText.includes('1052.6'));
  });
  test('hasPurchased returns true after payment', () => {
    assert(store.hasPurchased(signalId, 12345));
  });
  await asyncTest('duplicate payment (same charge ID) does not double-record', async () => {
    deliveredText = null;
    const r = await processSuccessfulPayment(
      { invoice_payload: `unlock_signal:${signalId}`, currency: 'XTR',
        total_amount: 200, telegram_payment_charge_id: 'charge_010' },
      12345, 'testuser', mockSendFn
    );
    assert(r.duplicate);
  });
  await asyncTest('repeat purchase by same user returns signal without new charge', async () => {
    deliveredText = null;
    const r = await processSuccessfulPayment(
      { invoice_payload: `unlock_signal:${signalId}`, currency: 'XTR',
        total_amount: 200, telegram_payment_charge_id: 'charge_011' },
      12345, 'testuser', mockSendFn
    );
    assert(r.delivered);
    assert(r.duplicate, 'Should be marked duplicate since already purchased');
    assert(deliveredText && deliveredText.includes('1052.6'));
  });
  await asyncTest('delivery failure does not mark payment as failed', async () => {
    const sid2 = store.createSignalRecord(mockSignal, mockAnalysis, 200);
    const failingSendFn = async () => { throw new Error('Network error'); };
    const r = await processSuccessfulPayment(
      { invoice_payload: `unlock_signal:${sid2}`, currency: 'XTR',
        total_amount: 200, telegram_payment_charge_id: 'charge_020' },
      99999, 'failuser', failingSendFn
    );
    assert(!r.delivered);
    assert(store.hasPurchased(sid2, 99999));
  });

  console.log('── Invoice ──');
  test('buildInvoice returns correct currency and price', () => {
    const inv = buildInvoice(signalId);
    assert(inv.currency === 'XTR');
    assert(inv.prices[0].amount === 200);
    assert(inv.payload === `unlock_signal:${signalId}`);
  });
  test('buildInvoice does not leak entry/SL/target in description', () => {
    const inv = buildInvoice(signalId);
    assert(!inv.description.includes('1052.6'));
    assert(!inv.description.includes('1047.3'));
    assert(!inv.description.includes('1063.2'));
  });

  if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

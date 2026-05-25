import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchStocks, fetchSignals, fetchTop, fetchHealth, triggerScan, placeOrder, fetchOrderLog, fetchLogs, clearLogs as apiClearLogs } from './api.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pct(v) {
  const n = parseFloat(v)
  return isNaN(n) ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`
}

function currency(v) {
  const n = parseFloat(v)
  return isNaN(n) ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
}

function fmt(v) {
  if (v == null) return '—'
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000)     return `${(v / 1_000).toFixed(0)}K`
  return String(v)
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Badge({ action, strength }) {
  const base = 'inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-wide'
  if (action === 'BUY') {
    const bg = strength === 'STRONG' ? 'bg-green-500 text-white' : 'bg-green-700 text-green-100'
    return <span className={`${base} ${bg}`}>▲ {strength === 'STRONG' ? 'Strong Buy' : 'Buy'}</span>
  }
  return <span className={`${base} bg-red-600 text-white`}>▼ Sell</span>
}

function ConfidenceBar({ value }) {
  const pct = Math.min(Math.max(value, 0), 100)
  const color = pct >= 75 ? 'bg-green-500' : pct >= 50 ? 'bg-yellow-400' : 'bg-red-500'
  return (
    <div className="flex items-center gap-2">
      <div className="w-24 bg-gray-700 rounded-full h-2">
        <div className={`${color} h-2 rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-300">{pct}%</span>
    </div>
  )
}

function StatCard({ label, value, sub, color }) {
  return (
    <div className="bg-gray-800 rounded-xl p-4 flex flex-col gap-1">
      <p className="text-xs text-gray-400 uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold ${color || 'text-white'}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500">{sub}</p>}
    </div>
  )
}

// ─── Toast Notification ───────────────────────────────────────────────────────

function Toast({ toasts }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => {
        const styles = t.type === 'success'
          ? 'bg-green-600 border-green-500'
          : t.type === 'error'
          ? 'bg-red-700 border-red-500'
          : 'bg-gray-700 border-gray-600'
        return (
          <div
            key={t.id}
            className={`${styles} border text-white text-sm px-4 py-3 rounded-xl shadow-xl max-w-sm animate-pulse-once`}
          >
            <p className="font-semibold">{t.title}</p>
            {t.message && <p className="text-xs mt-0.5 opacity-80">{t.message}</p>}
          </div>
        )
      })}
    </div>
  )
}

// ─── Confirmation Dialog ──────────────────────────────────────────────────────

function ConfirmDialog({ signal, onConfirm, onCancel }) {
  if (!signal) return null
  const isBuy = signal.action === 'BUY'
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl">
        <h2 className="text-lg font-bold text-white mb-1">Confirm Trade Execution</h2>
        <p className="text-gray-400 text-sm mb-5">Are you sure you want to place this trade?</p>
        <div className="bg-gray-800 rounded-xl p-4 space-y-2 text-sm mb-6">
          <div className="flex justify-between">
            <span className="text-gray-400">Symbol</span>
            <span className="font-bold text-white">{signal.symbol}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Action</span>
            <span className={`font-bold ${isBuy ? 'text-green-400' : 'text-red-400'}`}>{signal.action}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Entry</span>
            <span className="font-mono text-white">{currency(signal.entry)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Stop Loss</span>
            <span className="font-mono text-red-400">{currency(signal.stopLoss)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Target</span>
            <span className="font-mono text-green-400">{currency(signal.target)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Qty</span>
            <span className="font-mono text-white">{signal.positionSize ?? '—'} shares</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Risk</span>
            <span className="font-mono text-yellow-400">{currency(signal.riskAmount)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Confidence</span>
            <span className="font-mono text-white">{signal.confidence}%</span>
          </div>
        </div>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 bg-gray-700 hover:bg-gray-600 text-white text-sm font-semibold py-2.5 rounded-xl transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 text-white text-sm font-bold py-2.5 rounded-xl transition-colors ${
              isBuy ? 'bg-green-600 hover:bg-green-500' : 'bg-red-600 hover:bg-red-500'
            }`}
          >
            {isBuy ? '▲ Place BUY' : '▼ Place SELL'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Signals Table ────────────────────────────────────────────────────────────

function SignalsTable({ signals, onExecute, executingSymbol }) {
  if (!signals.length) {
    return (
      <div className="text-center py-12 text-gray-500">
        No actionable signals yet — waiting for next scan cycle…
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-700">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-800 text-gray-400 text-xs uppercase tracking-wide">
            <th className="px-4 py-3 text-left">Symbol</th>
            <th className="px-4 py-3 text-left">Signal</th>
            <th className="px-4 py-3 text-right">Price</th>
            <th className="px-4 py-3 text-right">Change</th>
            <th className="px-4 py-3 text-right">RSI</th>
            <th className="px-4 py-3 text-right">Qty</th>
            <th className="px-4 py-3 text-right">Entry</th>
            <th className="px-4 py-3 text-right">SL</th>
            <th className="px-4 py-3 text-right">Target</th>
            <th className="px-4 py-3 text-right">Exp. Profit</th>
            <th className="px-4 py-3 text-left">Confidence</th>
            <th className="px-4 py-3 text-left">Reason</th>
            <th className="px-4 py-3 text-right">Time</th>
            <th className="px-4 py-3 text-center">Execute</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {signals.map((s, i) => {
            const isBuy      = s.action === 'BUY'
            const rowBg      = isBuy ? 'bg-green-950/30 hover:bg-green-950/50' : 'bg-red-950/30 hover:bg-red-950/50'
            const chgColor   = s.changePercent >= 0 ? 'text-green-400' : 'text-red-400'
            const time       = new Date(s.timestamp).toLocaleTimeString()
            const analysis   = s.analysis || {}
            const confidence = s.confidence ?? analysis.confidence ?? 0
            const canExecute = confidence >= 75
            const isLoading  = executingSymbol === `${s.symbol}-${i}`
            const rsiVal     = s.rsi != null ? parseFloat(s.rsi).toFixed(1) : '—'
            const rsiColor   = s.rsi != null
              ? (s.rsi > 60 ? 'text-green-400' : s.rsi < 40 ? 'text-red-400' : 'text-yellow-400')
              : 'text-gray-500'
            const netProfit  = s.expectedProfit != null && s.expectedCost != null
              ? (s.expectedProfit - s.expectedCost).toFixed(0)
              : null

            return (
              <tr key={`${s.symbol}-${i}`} className={`${rowBg} transition-colors`}>
                <td className="px-4 py-3 font-bold text-white">{s.symbol}</td>
                <td className="px-4 py-3"><Badge action={s.action} strength={s.strength} /></td>
                <td className="px-4 py-3 text-right font-mono">{currency(s.price)}</td>
                <td className={`px-4 py-3 text-right font-mono ${chgColor}`}>{pct(s.changePercent)}</td>
                <td className={`px-4 py-3 text-right font-mono font-semibold ${rsiColor}`}>{rsiVal}</td>
                <td className="px-4 py-3 text-right font-mono text-gray-300">{s.positionSize ?? s.qty ?? '—'}</td>
                <td className="px-4 py-3 text-right font-mono text-blue-300">{currency(s.entry)}</td>
                <td className="px-4 py-3 text-right font-mono text-red-400">{currency(s.stopLoss ?? s.sl)}</td>
                <td className="px-4 py-3 text-right font-mono text-green-400">{currency(s.target)}</td>
                <td className="px-4 py-3 text-right font-mono">
                  {netProfit != null
                    ? <span className={parseFloat(netProfit) > 0 ? 'text-green-400' : 'text-red-400'}>₹{netProfit}</span>
                    : <span className="text-gray-500">—</span>}
                </td>
                <td className="px-4 py-3">
                  <ConfidenceBar value={confidence} />
                </td>
                <td className="px-4 py-3 text-gray-300 max-w-xs truncate" title={analysis.reason}>
                  {analysis.reason || (s.reasons || []).join('; ') || '—'}
                </td>
                <td className="px-4 py-3 text-right text-gray-500 text-xs">{time}</td>
                <td className="px-4 py-3 text-center">
                  {canExecute ? (
                    <button
                      onClick={() => onExecute(s, `${s.symbol}-${i}`)}
                      disabled={isLoading}
                      title={`${s.action} ${s.symbol}`}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                        isBuy
                          ? 'bg-green-600 hover:bg-green-500 active:scale-95'
                          : 'bg-red-600 hover:bg-red-500 active:scale-95'
                      }`}
                    >
                      {isLoading ? (
                        <>
                          <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                          </svg>
                          Placing…
                        </>
                      ) : (
                        <>{isBuy ? '▲' : '▼'} Execute</>
                      )}
                    </button>
                  ) : (
                    <span
                      title={`Confidence ${confidence}% < 75% required`}
                      className="inline-block px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-700 text-gray-500 cursor-not-allowed"
                    >
                      Low conf.
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Live Stocks Table ────────────────────────────────────────────────────────

function StocksTable({ stocks }) {
  if (!stocks.length) {
    return <div className="text-center py-12 text-gray-500">Loading stocks…</div>
  }

  const sorted = [...stocks].sort((a, b) => b.changePercent - a.changePercent)

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-700">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-800 text-gray-400 text-xs uppercase tracking-wide">
            <th className="px-4 py-3 text-left">Symbol</th>
            <th className="px-4 py-3 text-right">LTP</th>
            <th className="px-4 py-3 text-right">Change</th>
            <th className="px-4 py-3 text-right">High</th>
            <th className="px-4 py-3 text-right">Low</th>
            <th className="px-4 py-3 text-right">VWAP</th>
            <th className="px-4 py-3 text-right">EMA20</th>
            <th className="px-4 py-3 text-right">Volume</th>
            <th className="px-4 py-3 text-right">Vol Mult</th>
            <th className="px-4 py-3 text-center">Source</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {sorted.map((s) => {
            const chg = parseFloat(s.changePercent)
            const rowBg   = chg > 2  ? 'bg-green-950/20' : chg < -2 ? 'bg-red-950/20' : ''
            const chgColor= chg >= 0 ? 'text-green-400' : 'text-red-400'
            const srcColor= s.source === 'zerodha' ? 'text-blue-400' : 'text-gray-500'

            return (
              <tr key={s.symbol} className={`${rowBg} hover:bg-gray-800/50 transition-colors`}>
                <td className="px-4 py-2.5 font-bold text-white">{s.symbol}</td>
                <td className="px-4 py-2.5 text-right font-mono">{currency(s.price)}</td>
                <td className={`px-4 py-2.5 text-right font-mono font-semibold ${chgColor}`}>{pct(s.changePercent)}</td>
                <td className="px-4 py-2.5 text-right font-mono text-gray-300">{currency(s.dayHigh)}</td>
                <td className="px-4 py-2.5 text-right font-mono text-gray-300">{currency(s.dayLow)}</td>
                <td className="px-4 py-2.5 text-right font-mono text-purple-300">{currency(s.vwap)}</td>
                <td className="px-4 py-2.5 text-right font-mono text-yellow-300">{s.ema20 ? currency(s.ema20) : '—'}</td>
                <td className="px-4 py-2.5 text-right text-gray-300">{fmt(s.volume)}</td>
                <td className="px-4 py-2.5 text-right text-gray-300">{s.volumeMultiplier}x</td>
                <td className={`px-4 py-2.5 text-center text-xs font-medium ${srcColor}`}>{s.source}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Order Leg Status Badge ───────────────────────────────────────────────────

function OrderLegBadge({ orderId, error, label }) {
  if (orderId) {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-gray-400 text-xs">{label}</span>
        <span className="text-green-400 font-mono text-xs">✔ {orderId}</span>
      </div>
    )
  }
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-gray-400 text-xs">{label}</span>
      <span className="text-red-400 text-xs">✘ {error || 'not placed'}</span>
    </div>
  )
}

// ─── Order Details Modal ──────────────────────────────────────────────────────

function OrderDetailsModal({ order, onClose }) {
  if (!order) return null
  const isBuy = order.action === 'BUY'
  const statusColors = {
    SUCCESS:  'text-green-400 bg-green-950',
    FAILED:   'text-red-400 bg-red-950',
    REJECTED: 'text-yellow-400 bg-yellow-950',
  }
  const statusDot = { SUCCESS: '🟢', FAILED: '🔴', REJECTED: '🟡' }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-white">{order.symbol} — {order.action}</h2>
            <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-full mt-1 ${statusColors[order.status] || 'text-gray-400 bg-gray-800'}`}>
              {statusDot[order.status]} {order.status}
            </span>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-2xl leading-none">×</button>
        </div>

        {/* Trade details */}
        <div className="bg-gray-800 rounded-xl p-4 space-y-2 text-sm mb-4">
          {[
            ['Entry Price', currency(order.entry)],
            ['Stop Loss',   currency(order.stopLoss)],
            ['Target',      currency(order.target)],
            ['Qty',         order.quantity ?? '—'],
            ['Product',     order.product  ?? '—'],
            ['Confidence',  order.confidence != null ? `${order.confidence}%` : '—'],
            ['Logged at',   order.loggedAt ? new Date(order.loggedAt).toLocaleString() : '—'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <span className="text-gray-400">{k}</span>
              <span className="font-mono text-white">{v}</span>
            </div>
          ))}
        </div>

        {/* Order leg statuses */}
        {order.status !== 'REJECTED' && (
          <div className="bg-gray-800 rounded-xl p-4 space-y-2.5">
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Order Legs</p>
            <OrderLegBadge label="Entry Order ID"     orderId={order.orderId}       error={order.reason} />
            <OrderLegBadge label="Stop Loss Order ID" orderId={order.slOrderId}     error={order.slError} />
            <OrderLegBadge label="Target Order ID"    orderId={order.targetOrderId} error={order.targetError} />
          </div>
        )}

        {order.status === 'REJECTED' && (
          <div className="bg-yellow-950/40 border border-yellow-800 rounded-xl p-4 text-sm text-yellow-300">
            <p className="font-semibold mb-1">Rejected by safety gates</p>
            <p className="opacity-80">{order.reason}</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const styles = {
    SUCCESS:  'bg-green-500/20 text-green-400 border border-green-700',
    FAILED:   'bg-red-500/20 text-red-400 border border-red-700',
    REJECTED: 'bg-yellow-500/20 text-yellow-400 border border-yellow-700',
  }
  const dots = { SUCCESS: '🟢', FAILED: '🔴', REJECTED: '🟡' }
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${styles[status] || 'bg-gray-700 text-gray-400'}`}>
      {dots[status] || '⚪'} {status}
    </span>
  )
}

// ─── Orders Table ─────────────────────────────────────────────────────────────

function OrdersTable({ orders, onSelectOrder }) {
  if (!orders.length) {
    return (
      <div className="text-center py-12 text-gray-500">
        No orders placed yet this session.
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-700">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-800 text-gray-400 text-xs uppercase tracking-wide">
            <th className="px-4 py-3 text-left">Time</th>
            <th className="px-4 py-3 text-left">Symbol</th>
            <th className="px-4 py-3 text-left">Action</th>
            <th className="px-4 py-3 text-right">Qty</th>
            <th className="px-4 py-3 text-right">Entry</th>
            <th className="px-4 py-3 text-right">SL</th>
            <th className="px-4 py-3 text-right">Target</th>
            <th className="px-4 py-3 text-left">Status</th>
            <th className="px-4 py-3 text-left">Entry Order</th>
            <th className="px-4 py-3 text-left">SL Order</th>
            <th className="px-4 py-3 text-left">Target Order</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {orders.map((o, i) => {
            const isBuy = o.action === 'BUY'
            return (
              <tr
                key={i}
                onClick={() => onSelectOrder(o)}
                className="hover:bg-gray-800/60 cursor-pointer transition-colors"
                title="Click for details"
              >
                <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                  {o.loggedAt ? new Date(o.loggedAt).toLocaleTimeString() : '—'}
                </td>
                <td className="px-4 py-3 font-bold text-white">{o.symbol}</td>
                <td className={`px-4 py-3 font-semibold ${isBuy ? 'text-green-400' : 'text-red-400'}`}>
                  {isBuy ? '▲' : '▼'} {o.action}
                </td>
                <td className="px-4 py-3 text-right font-mono text-gray-300">{o.quantity ?? '—'}</td>
                <td className="px-4 py-3 text-right font-mono text-blue-300">{currency(o.entry)}</td>
                <td className="px-4 py-3 text-right font-mono text-red-400">{currency(o.stopLoss)}</td>
                <td className="px-4 py-3 text-right font-mono text-green-400">{currency(o.target)}</td>
                <td className="px-4 py-3"><StatusBadge status={o.status} /></td>
                <td className="px-4 py-3 font-mono text-xs">
                  {o.orderId
                    ? <span className="text-green-400">{o.orderId}</span>
                    : <span className="text-red-400 truncate max-w-[8rem] block" title={o.reason}>{o.reason || '—'}</span>}
                </td>
                <td className="px-4 py-3 font-mono text-xs">
                  {o.slOrderId
                    ? <span className="text-green-400">{o.slOrderId}</span>
                    : <span className="text-yellow-600">—</span>}
                </td>
                <td className="px-4 py-3 font-mono text-xs">
                  {o.targetOrderId
                    ? <span className="text-green-400">{o.targetOrderId}</span>
                    : <span className="text-yellow-600">—</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Top Movers ───────────────────────────────────────────────────────────────

function TopMovers({ gainers, losers }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="bg-gray-800 rounded-xl p-4">
        <h3 className="text-green-400 font-semibold mb-3 text-sm uppercase tracking-wide">🚀 Top Gainers</h3>
        <div className="space-y-2">
          {gainers.map((s) => (
            <div key={s.symbol} className="flex justify-between items-center">
              <span className="font-bold text-white">{s.symbol}</span>
              <div className="text-right">
                <div className="text-green-400 font-mono text-sm font-semibold">{pct(s.changePercent)}</div>
                <div className="text-gray-400 text-xs">{currency(s.price)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="bg-gray-800 rounded-xl p-4">
        <h3 className="text-red-400 font-semibold mb-3 text-sm uppercase tracking-wide">📉 Top Losers</h3>
        <div className="space-y-2">
          {losers.map((s) => (
            <div key={s.symbol} className="flex justify-between items-center">
              <span className="font-bold text-white">{s.symbol}</span>
              <div className="text-right">
                <div className="text-red-400 font-mono text-sm font-semibold">{pct(s.changePercent)}</div>
                <div className="text-gray-400 text-xs">{currency(s.price)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────

// ─── Debug Logs Table ──────────────────────────────────────────────────────────

const TYPE_STYLES = {
  INFO:   'bg-blue-900/60 text-blue-300 border border-blue-700',
  ERROR:  'bg-red-900/60 text-red-300 border border-red-700',
  SIGNAL: 'bg-yellow-900/60 text-yellow-300 border border-yellow-700',
  TRADE:  'bg-green-900/60 text-green-300 border border-green-700',
}

function LogTypeBadge({ type }) {
  const cls = TYPE_STYLES[type] || 'bg-gray-700 text-gray-300 border border-gray-600'
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wide ${cls}`}>
      {type}
    </span>
  )
}

function DebugLogs({ logs, onClear }) {
  const [filter, setFilter] = useState('ALL')
  const types = ['ALL', 'INFO', 'ERROR', 'SIGNAL', 'TRADE']

  const visible = filter === 'ALL' ? logs : logs.filter((l) => l.type === filter)

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 bg-gray-800 p-1 rounded-lg">
          {types.map((t) => (
            <button
              key={t}
              onClick={() => setFilter(t)}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                filter === t ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500">{visible.length} entries</span>
          <button
            onClick={onClear}
            className="bg-red-700 hover:bg-red-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
          >
            Clear Logs
          </button>
        </div>
      </div>

      {/* Table */}
      {visible.length === 0 ? (
        <div className="text-center text-gray-500 py-16 text-sm">No logs yet. Logs appear during market hours.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-800 text-gray-400 text-xs uppercase tracking-wide">
                <th className="px-4 py-3 text-left whitespace-nowrap">Time</th>
                <th className="px-4 py-3 text-left">Type</th>
                <th className="px-4 py-3 text-left">Message</th>
                <th className="px-4 py-3 text-left">Data</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {[...visible].reverse().map((entry, idx) => (
                <tr key={idx} className="hover:bg-gray-800/50 transition-colors align-top">
                  <td className="px-4 py-2.5 text-gray-400 whitespace-nowrap font-mono text-xs">
                    {new Date(entry.time).toLocaleTimeString()}
                  </td>
                  <td className="px-4 py-2.5">
                    <LogTypeBadge type={entry.type} />
                  </td>
                  <td className="px-4 py-2.5 text-gray-200">{entry.message}</td>
                  <td className="px-4 py-2.5">
                    {entry.data ? (
                      <pre className="text-xs text-gray-400 whitespace-pre-wrap break-all max-w-md font-mono">
                        {JSON.stringify(entry.data, null, 2)}
                      </pre>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────────

const TABS = ['Signals', 'Orders', 'Stocks', 'Top Movers', 'Debug Logs']

export default function App() {
  const [tab,          setTab]          = useState('Signals')
  const [stocks,       setStocks]       = useState([])
  const [signals,      setSignals]      = useState([])
  const [top,          setTop]          = useState({ gainers: [], losers: [] })
  const [health,       setHealth]       = useState(null)
  const [lastUpdated,  setLastUpdated]  = useState(null)
  const [scanning,     setScanning]     = useState(false)
  const [error,        setError]        = useState(null)
  // Order execution state
  const [confirmSignal, setConfirmSignal] = useState(null)
  const [executingKey,  setExecutingKey]  = useState(null)
  const [toasts,        setToasts]        = useState([])
  const toastIdRef = useRef(0)
  // Order log state
  const [orders,        setOrders]        = useState([])
  const [selectedOrder, setSelectedOrder] = useState(null)
  // Debug logs state
  const [debugLogs,     setDebugLogs]     = useState([])

  const refresh = useCallback(async () => {
    try {
      const [s, sig, t, h] = await Promise.all([
        fetchStocks(),
        fetchSignals(),
        fetchTop(),
        fetchHealth(),
      ])
      setStocks(s.stocks  || [])
      setSignals(sig.signals || [])
      setTop({ gainers: t.gainers || [], losers: t.losers || [] })
      setHealth(h)
      setLastUpdated(new Date())
      setError(null)
      // refresh order log silently
      try {
        const log = await fetchOrderLog()
        setOrders(log.orders || [])
      } catch (_) {}
    } catch (e) {
      setError(`Cannot reach backend — ${e.message}`)
    }
  }, [])

  // Auto-refresh every 2 seconds
  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 2_000)
    return () => clearInterval(id)
  }, [refresh])

  // Poll debug logs every 3 seconds independently
  useEffect(() => {
    async function pollLogs() {
      try {
        const data = await fetchLogs()
        setDebugLogs(data.logs || [])
      } catch (_) {}
    }
    pollLogs()
    const id = setInterval(pollLogs, 3_000)
    return () => clearInterval(id)
  }, [])

  async function handleClearLogs() {
    try {
      await apiClearLogs()
      setDebugLogs([])
    } catch (_) {}
  }

  async function handleScan() {
    setScanning(true)
    try { await triggerScan() } catch (_) {}
    await refresh()
    setScanning(false)
  }

  function addToast(type, title, message) {
    const id = ++toastIdRef.current
    setToasts((prev) => [...prev, { id, type, title, message }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000)
  }

  // Step 1: button click → open confirmation dialog
  function handleExecuteClick(signal, rowKey) {
    setConfirmSignal({ ...signal, _rowKey: rowKey })
  }

  // Step 2: user confirmed → call API
  async function handleConfirm() {
    const signal = confirmSignal
    const rowKey = signal._rowKey
    setConfirmSignal(null)
    setExecutingKey(rowKey)
    try {
      const result = await placeOrder(signal)
      if (result.status === 'SUCCESS') {
        addToast('success', `Order placed — ${signal.action} ${signal.symbol}`, `Order ID: ${result.orderId}`)
      } else {
        addToast('error', `Order ${result.status} — ${signal.symbol}`, result.reason)
      }
    } catch (err) {
      addToast('error', `Order failed — ${signal.symbol}`, err.message)
    } finally {
      setExecutingKey(null)
    }
  }

  const buyCount  = signals.filter((s) => s.action === 'BUY').length
  const sellCount = signals.filter((s) => s.action === 'SELL').length
  const dataSource = stocks[0]?.source || '—'
  const totalExpectedProfit = signals.reduce((acc, s) => {
    const net = (s.expectedProfit ?? 0) - (s.expectedCost ?? 0)
    return acc + (net > 0 ? net : 0)
  }, 0)

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="bg-gray-900 border-b border-gray-800 px-6 py-4">
        <div className="max-w-screen-2xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
              🤖 <span>Algorithmic Trading AI</span>
            </h1>
            <p className="text-xs text-gray-400 mt-0.5">
              Data: <span className="text-blue-400 font-medium capitalize">{dataSource}</span>
              {lastUpdated && (
                <> · Updated <span className="text-gray-300">{lastUpdated.toLocaleTimeString()}</span></>
              )}
              {health && (
                <> · Uptime <span className="text-gray-300">{Math.floor(health.uptime)}s</span></>
              )}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {error && (
              <span className="text-red-400 text-xs bg-red-950 px-3 py-1 rounded-lg">{error}</span>
            )}
            <span className="text-xs text-gray-400 hidden sm:block">Auto-refresh 2s</span>
            <button
              onClick={handleScan}
              disabled={scanning}
              className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
            >
              {scanning ? '⏳ Scanning…' : '⚡ Scan Now'}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-4">
          <StatCard label="Live Stocks"   value={stocks.length}  sub="tracked instruments" />
          <StatCard label="Total Signals" value={signals.length} sub="last 100 cycles" />
          <StatCard label="BUY Signals"   value={buyCount}       color="text-green-400" sub="active" />
          <StatCard label="SELL Signals"  value={sellCount}      color="text-red-400"   sub="active" />
          <StatCard
            label="Exp. Profit Today"
            value={totalExpectedProfit > 0 ? `₹${Math.round(totalExpectedProfit)}` : '₹0'}
            color={totalExpectedProfit >= 150 ? 'text-green-400' : totalExpectedProfit > 0 ? 'text-yellow-400' : 'text-gray-400'}
            sub={`if ${signals.length} signal${signals.length !== 1 ? 's' : ''} hit target`}
          />
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-gray-800 p-1 rounded-xl w-fit">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                tab === t ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {tab === 'Signals'    && <SignalsTable signals={signals} onExecute={handleExecuteClick} executingSymbol={executingKey} />}
        {tab === 'Orders'     && <OrdersTable orders={orders} onSelectOrder={setSelectedOrder} />}
        {tab === 'Stocks'     && <StocksTable stocks={stocks} />}
        {tab === 'Top Movers' && <TopMovers gainers={top.gainers} losers={top.losers} />}
        {tab === 'Debug Logs' && <DebugLogs logs={debugLogs} onClear={handleClearLogs} />}
      </main>

      {/* Order details modal */}
      <OrderDetailsModal order={selectedOrder} onClose={() => setSelectedOrder(null)} />

      {/* Confirmation dialog */}
      <ConfirmDialog
        signal={confirmSignal}
        onConfirm={handleConfirm}
        onCancel={() => setConfirmSignal(null)}
      />

      {/* Toast notifications */}
      <Toast toasts={toasts} />
    </div>
  )
}

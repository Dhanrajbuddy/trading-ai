// Resolve backend URL:
//   - In Docker: VITE_API_URL injected at build time (e.g. http://localhost:3000)
//   - In dev proxy mode: /api prefix is proxied by Vite to backend
const BASE = import.meta.env.VITE_API_URL || '/api'

async function get(path) {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function fetchStocks()  { return get('/stocks')  }
export async function fetchSignals() { return get('/signals') }
export async function fetchTop()     { return get('/top')     }
export async function fetchHealth()  { return get('/health')  }
export async function triggerScan()  {
  const res = await fetch(`${BASE}/scan`, { method: 'POST' })
  return res.json()
}

export async function placeOrder(signal) {
  const res = await fetch(`${BASE}/orders/place`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(signal),
  })
  const data = await res.json()
  if (!res.ok && res.status !== 400) throw new Error(data.message || `HTTP ${res.status}`)
  return data
}

export async function fetchOrderLog() { return get('/orders/log') }
export async function fetchStats()    { return get('/stats')      }

export async function fetchLogs(type) {
  const qs = type ? `?type=${type}` : ''
  return get(`/logs${qs}`)
}

export async function clearLogs() {
  const res = await fetch(`${BASE}/logs/clear`, { method: 'POST' })
  return res.json()
}

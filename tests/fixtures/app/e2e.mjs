// Health contract against a running server. EXPECTED_REVISION, when set, must match.
import process from 'node:process'

const base = `http://127.0.0.1:${process.env.PORT ?? 3000}`
const timeout = Number(process.env.E2E_TIMEOUT_MS ?? 5000)

function get(path) {
  return fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeout) })
}

const res = await get('/api/health')
if (!res.ok) throw new Error(`health returned ${res.status}`)
const type = res.headers.get('content-type') ?? ''
if (!type.startsWith('application/json')) throw new Error(`unexpected content type: ${type}`)
const body = await res.json()
if (body.status !== 'ok') throw new Error(`unexpected health: ${JSON.stringify(body)}`)
const expected = process.env.EXPECTED_REVISION
if (expected !== undefined && body.revision !== expected) {
  throw new Error(`revision ${JSON.stringify(body.revision)}, expected ${JSON.stringify(expected)}`)
}

const missing = await get('/does-not-exist')
if (missing.status !== 404) throw new Error(`unknown path returned ${missing.status}, expected 404`)

console.log('e2e ok')

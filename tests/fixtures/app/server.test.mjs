import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'

const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url))
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const revision = 'test-revision-1234'

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))))
    })
  })
}

let child
let base

async function waitForServer(url, deadlineMs) {
  const deadline = Date.now() + deadlineMs
  let lastError
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`)
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) })
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error(`server not ready: ${lastError}`)
}

before(async () => {
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(port), DEPLOYMENT_REVISION: revision },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  await waitForServer(`${base}/api/health`, 10_000)
})

after(() => {
  if (child && child.exitCode === null) child.kill('SIGKILL')
})

test('health answers 200 JSON with status ok and the env revision', async () => {
  const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/json')
  assert.deepEqual(await res.json(), { status: 'ok', revision })
})

test('unknown paths answer 404', async () => {
  for (const path of ['/', '/api/health/extra', '/api/other']) {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) })
    assert.equal(res.status, 404, path)
    await res.arrayBuffer()
  }
})

test('--version prints the package.json version', () => {
  const out = execFileSync(process.execPath, [serverPath, '--version'], { encoding: 'utf8' })
  assert.equal(out.trim(), version)
})

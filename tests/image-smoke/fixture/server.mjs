// Smallest image that satisfies the health contract: GET /api/health -> {status, revision}.
// Test knobs (env): READY_AFTER_MS, HEALTH_STATUS, RAW_BODY, CRASH.
import { createServer } from 'node:http'
import process from 'node:process'

const revision = process.env.DEPLOYMENT_REVISION ?? ''
const port = Number(process.env.PORT ?? 3000)
const readyAt = Date.now() + Number(process.env.READY_AFTER_MS ?? 0)

if (process.env.CRASH === '1') {
  console.error('crashing on purpose')
  process.exit(1)
}

createServer((req, res) => {
  if (req.url !== '/api/health') {
    res.writeHead(404).end()
    return
  }
  if (Date.now() < readyAt) {
    res.writeHead(503).end()
    return
  }
  if (process.env.RAW_BODY) {
    res.writeHead(200, { 'content-type': 'text/plain' }).end(process.env.RAW_BODY)
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ status: process.env.HEALTH_STATUS ?? 'ok', revision }))
}).listen(port)

#!/usr/bin/env node
// Health contract fixture: GET /api/health -> {status, revision}.
import { createServer } from 'node:http'
import process from 'node:process'

if (process.argv.includes('--version')) {
  console.log('0.0.0')
  process.exit(0)
}

createServer((req, res) => {
  if (req.url !== '/api/health') return res.writeHead(404).end()
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ status: 'ok', revision: process.env.DEPLOYMENT_REVISION ?? '' }))
}).listen(Number(process.env.PORT ?? 3000))

// Copies the server into dist/ and proves the built copy runs.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const dist = new URL('dist/', root)
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist)
for (const file of ['server.mjs', 'package.json']) copyFileSync(new URL(file, root), new URL(file, dist))

const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const out = execFileSync(process.execPath, [fileURLToPath(new URL('server.mjs', dist)), '--version'], { encoding: 'utf8' }).trim()
if (out !== version) throw new Error(`dist/server.mjs --version printed ${JSON.stringify(out)}, expected ${version}`)
console.log(`built dist/server.mjs (${version})`)

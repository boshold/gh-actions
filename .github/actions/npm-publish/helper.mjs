// Helpers for publish.sh: node helper.mjs <list|manifest|dist-tag|lt|json> [...]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const [command, ...args] = process.argv.slice(2)

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
  if (!m) throw new Error(`invalid version: ${v}`)
  return m.slice(1, 4).map(Number)
}

function lessThan(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)]
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i]
  }
  return false
}

// Non-private workspace packages, dependencies first.
function workspacePackages() {
  const raw = execFileSync('pnpm', ['ls', '--recursive', '--depth', '-1', '--json'], { encoding: 'utf8' })
  const projects = JSON.parse(raw)
  const cwd = process.cwd()
  const byName = new Map()
  for (const p of projects) {
    const manifest = JSON.parse(readFileSync(path.join(p.path, 'package.json'), 'utf8'))
    if (manifest.private === true || !manifest.name) continue
    const deps = Object.keys({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    })
    byName.set(manifest.name, { dir: path.relative(cwd, p.path) || '.', deps })
  }
  const order = []
  const state = new Map()
  const visit = (name) => {
    if (state.get(name) === 'done') return
    if (state.get(name) === 'visiting') return
    state.set(name, 'visiting')
    for (const dep of byName.get(name).deps) {
      if (byName.has(dep)) visit(dep)
    }
    state.set(name, 'done')
    order.push(byName.get(name).dir)
  }
  for (const name of [...byName.keys()].sort()) visit(name)
  return order
}

function list(input) {
  const text = (input ?? '').trim()
  if (text === '') return workspacePackages()
  if (text.startsWith('[')) {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) throw new Error('packages JSON must be an array of strings')
    return parsed.map((x) => x.trim()).filter(Boolean)
  }
  return text.split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('#'))
}

function distTag(version) {
  const pre = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(version)
  if (!pre) return 'latest'
  return /^\d+$/.test(pre[1]) ? 'next' : pre[1]
}

switch (command) {
  case 'list':
    for (const entry of list(args[0])) console.log(entry)
    break
  case 'manifest': {
    const m = JSON.parse(readFileSync(0, 'utf8'))
    if (typeof m.name !== 'string' || typeof m.version !== 'string') throw new Error('package.json needs name and version')
    console.log([m.name, m.version, m.private === true, m.publishConfig?.registry || '-'].join(' '))
    break
  }
  case 'dist-tag':
    console.log(distTag(args[0]))
    break
  case 'lt':
    process.exit(lessThan(args[0], args[1]) ? 0 : 1)
    break
  case 'json':
    console.log(JSON.stringify(args))
    break
  default:
    console.error(`unknown command: ${command}`)
    process.exit(2)
}

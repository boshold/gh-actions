// Helpers for publish.sh: node helper.mjs <list|manifest|integrity|github-version|dist-tag|lt|json> [...]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

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

async function githubVersionIntegrity(name, version, expected, waitForPublish) {
  if (!/^@[^/\s]+\/[^/\s]+$/u.test(name)) throw new Error(`GitHub Packages needs a scoped package name: ${name}`)
  const token = process.env.PUBLISH_TOKEN
  if (!token) throw new Error('GitHub Packages integrity checks need a registry token')
  const spec = `${name}@${version}`
  const url = new URL(encodeURIComponent(name), 'https://npm.pkg.github.com/')
  for (let attempt = 0; attempt < (waitForPublish ? 5 : 1); attempt++) {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.npm.install-v1+json', 'cache-control': 'no-cache' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status !== 404) {
      if (!response.ok) throw new Error(`Cannot check ${spec} on GitHub Packages (HTTP ${response.status})`)
      const metadata = await response.json()
      const versions = metadata?.versions
      if (metadata?.name !== name || !versions || typeof versions !== 'object' || Array.isArray(versions)) {
        throw new Error(`Invalid GitHub Packages metadata for ${spec}`)
      }
      if (Object.hasOwn(versions, version)) {
        if (versions[version]?.dist?.integrity !== expected) {
          throw new Error(`GitHub Packages integrity mismatch for ${spec}; refusing to publish or reuse it`)
        }
        return true
      }
    } else await response.body?.cancel()
    if (!waitForPublish) return false
    if (attempt < 4) await delay(1000)
  }
  throw new Error(`${spec} is not yet visible on GitHub Packages`)
}

switch (command) {
  case 'list':
    for (const entry of list(args[0])) console.log(entry)
    break
  case 'manifest': {
    const m = JSON.parse(readFileSync(args[0], 'utf8'))
    if (typeof m.name !== 'string' || !m.name || /\s/u.test(m.name) || typeof m.version !== 'string' || !m.version || /\s/u.test(m.version)) {
      throw new Error('package.json needs name and version without whitespace')
    }
    console.log([m.name, m.version, m.private === true, m.publishConfig?.registry || '-'].join(' '))
    break
  }
  case 'integrity': {
    const hash = createHash('sha512')
    for await (const chunk of createReadStream(args[0])) hash.update(chunk)
    console.log(`sha512-${hash.digest('base64')}`)
    break
  }
  case 'github-version':
    console.log(await githubVersionIntegrity(args[0], args[1], args[2], args[3] === 'wait'))
    break
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

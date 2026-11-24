import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const publisher = fileURLToPath(new URL('../../.github/actions/npm-publish/publish.sh', import.meta.url))
const workflow = new URL('../../.github/workflows/release-npm.yml', import.meta.url)
const version = '1.0.0'
const names = ['@example/library', '@example/module', '@example/cli']

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'npm-publish-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const bin = join(cwd, 'bin')
  mkdirSync(bin)
  const stateFile = join(cwd, 'registry.json')
  const attemptsFile = join(cwd, 'attempts')
  const outputFile = join(cwd, 'outputs')
  const fetchFile = join(cwd, 'fetch.mjs')
  const writeState = state => writeFileSync(stateFile, JSON.stringify(state))
  writeState({ versions: {} })
  writeFileSync(attemptsFile, '')
  writeFileSync(fetchFile, `
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
globalThis.fetch = async (url, init) => {
  assert.equal(process.env.NO_FETCH, undefined)
  assert.equal(url.origin, 'https://npm.pkg.github.com')
  assert.equal(init.redirect, 'error')
  assert.equal(init.headers.authorization, 'Bearer fixture-token')
  const name = decodeURIComponent(url.pathname.slice(1))
  const state = JSON.parse(readFileSync(process.env.REGISTRY_STATE, 'utf8'))
  if (state.status) return Response.json({}, { status: state.status })
  if (!Object.hasOwn(state.versions, name)) return Response.json({}, { status: 404 })
  return Response.json({ name, versions: state.versions[name] })
}
`)
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env bash
exec node "$FAKE_NPM" "$@"
`, { mode: 0o700 })
  const fakeNpm = join(cwd, 'npm.mjs')
  writeFileSync(fakeNpm, `
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
const [command, file, ...flags] = process.argv.slice(2)
if (command === '--version') {
  console.log('11.20.0')
  process.exit(0)
}
const state = JSON.parse(readFileSync(process.env.REGISTRY_STATE, 'utf8'))
if (command === 'view') {
  if (state.legacyExisting === file) console.log('1.0.0')
  process.exit(0)
}
assert.equal(command, 'publish')
assert.ok(flags.includes('--ignore-scripts'))
assert.equal(process.env.NODE_AUTH_TOKEN, 'fixture-token')
const { name, version } = JSON.parse(execFileSync('tar', ['-xzOf', file, 'package/package.json']))
const dryRun = flags.includes('--dry-run')
appendFileSync(process.env.ATTEMPTS_FILE, (dryRun ? 'dry ' : 'publish ') + name + '\\n')
if (dryRun) process.exit(0)
if (name === process.env.FAIL_NAME) process.exit(17)
const integrity = name === process.env.CORRUPT_NAME
  ? 'sha512-wrong'
  : 'sha512-' + createHash('sha512').update(readFileSync(file)).digest('base64')
state.versions[name] ??= {}
state.versions[name][version] = { dist: { integrity } }
writeFileSync(process.env.REGISTRY_STATE, JSON.stringify(state))
`)

  let count = 0
  const pack = (name, overrides = {}) => {
    const base = join(cwd, `src-${++count}`)
    const file = join(cwd, `packed ${count}.tgz`)
    mkdirSync(join(base, 'package'), { recursive: true })
    writeFileSync(join(base, 'package', 'package.json'), JSON.stringify({
      name, version, publishConfig: { registry: 'https://npm.pkg.github.com' }, ...overrides,
    }))
    execFileSync('tar', ['-czf', file, '-C', base, 'package/package.json'])
    return { file, integrity: 'sha512-' + createHash('sha512').update(readFileSync(file)).digest('base64') }
  }
  return {
    pack,
    writeState,
    state: () => JSON.parse(readFileSync(stateFile, 'utf8')),
    attempts: () => readFileSync(attemptsFile, 'utf8').trim().split('\n').filter(Boolean),
    outputs: () => readFileSync(outputFile, 'utf8'),
    publish: (packages, overrides = {}) => spawnSync('bash', [publisher], {
      cwd,
      env: {
        PATH: bin + ':' + process.env.PATH,
        NODE_OPTIONS: '--import=' + fetchFile,
        FAKE_NPM: fakeNpm,
        PACKAGES: packages.map(({ file }) => file).join('\n'),
        REGISTRY: 'github',
        VERIFY_ARTIFACT_INTEGRITY: 'true',
        PUBLISH_TOKEN: 'fixture-token',
        EXPECTED_VERSION: version,
        REGISTRY_STATE: stateFile,
        ATTEMPTS_FILE: attemptsFile,
        GITHUB_OUTPUT: outputFile,
        ...overrides,
      },
      encoding: 'utf8',
    }),
  }
}

test('partial publication retries with the original tarballs and skips only matching bytes', t => {
  const f = fixture(t)
  const packages = names.map(name => f.pack(name))
  const first = f.publish(packages, { FAIL_NAME: names[1] })
  assert.equal(first.status, 17, first.stderr)
  assert.deepEqual(f.attempts(), names.slice(0, 2).map(name => 'publish ' + name))
  assert.deepEqual(Object.keys(f.state().versions), [names[0]])

  const retry = f.publish(packages)
  assert.equal(retry.status, 0, retry.stdout + retry.stderr)
  assert.deepEqual(f.attempts(), [names[0], names[1], names[1], names[2]].map(name => 'publish ' + name))
  assert.equal(f.outputs(), `published=["${names[1]}@${version}","${names[2]}@${version}"]\nskipped=["${names[0]}@${version}"]\n`)
  assert.deepEqual(names.map(name => f.state().versions[name][version].dist.integrity), packages.map(({ integrity }) => integrity))
})

test('conflicting bytes or missing integrity hold all uploads', t => {
  const f = fixture(t)
  const packages = names.map(name => f.pack(name))
  for (const dist of [{ integrity: 'sha512-wrong' }, {}]) {
    f.writeState({ versions: { [names[1]]: { [version]: { dist } } } })
    const result = f.publish(packages)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /integrity mismatch/)
    assert.deepEqual(f.attempts(), [])
  }
})

test('registry authorization and service errors hold all uploads', t => {
  const f = fixture(t)
  const packages = names.map(name => f.pack(name))
  for (const status of [401, 403, 500]) {
    f.writeState({ status, versions: {} })
    const result = f.publish(packages)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, new RegExp(`HTTP ${status}`))
    assert.deepEqual(f.attempts(), [])
  }
})

test('a successful upload still fails the publish step if the registry reports different bytes', t => {
  const f = fixture(t)
  const result = f.publish([f.pack(names[0])], { CORRUPT_NAME: names[0] })
  assert.notEqual(result.status, 0)
  assert.deepEqual(f.attempts(), ['publish ' + names[0]])
  assert.match(result.stderr, /integrity mismatch/)
  assert.throws(() => f.outputs(), { code: 'ENOENT' })
})

test('every tarball manifest must have the correct version before any upload', t => {
  const f = fixture(t)
  const result = f.publish([f.pack(names[0]), f.pack(names[1], { version: '2.0.0' })])
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /has version 2.0.0, expected 1.0.0/)
  assert.deepEqual(f.attempts(), [])
})

test('dry run reads real tarball manifests and sends no registry writes', t => {
  const f = fixture(t)
  const packages = names.map(name => f.pack(name))
  const result = f.publish(packages, { DRY_RUN: 'true', NO_FETCH: 'true' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(f.attempts(), names.map(name => 'dry ' + name))
  assert.deepEqual(f.state().versions, {})
})

test('regular npm publishing still skips existing versions without strict integrity checks', t => {
  const f = fixture(t)
  const result = f.publish([f.pack(names[0])], { REGISTRY: 'npmjs', VERIFY_ARTIFACT_INTEGRITY: 'false', NO_FETCH: 'true' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(f.attempts(), ['publish ' + names[0]])
  f.writeState({ legacyExisting: names[0] + '@' + version, versions: {} })
  const retry = f.publish([f.pack(names[0])], { REGISTRY: 'npmjs', VERIFY_ARTIFACT_INTEGRITY: 'false', NO_FETCH: 'true' })
  assert.equal(retry.status, 0, retry.stdout + retry.stderr)
  assert.deepEqual(f.attempts(), ['publish ' + names[0]])
})

test('artifact-backed workflow finalizes the draft after the integrity-checked publish step', () => {
  const source = readFileSync(workflow, 'utf8')
  assert.match(source, /retention-days: 7/)
  assert.match(source, /digest-mismatch: error/)
  assert.match(source, /needs\.build\.outputs\.resumed == 'true' \|\| github\.run_attempt > 1/)
  assert.match(source, /draft: true[\s\S]*verify-artifact-integrity: true[\s\S]*mode: finalize/)
})

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const action = join(import.meta.dirname, '../../.github/actions/services')

// Fake docker/curl log their args; FAIL_DOCKER makes every docker call fail.
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'services-'))
  const log = join(dir, 'calls.log')
  const bin = join(dir, 'bin')
  spawnSync('mkdir', [bin])
  for (const name of ['docker', 'curl']) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n[[ -z "\${FAIL_DOCKER:-}" ]]\n`)
    chmodSync(join(bin, name), 0o755)
  }
  writeFileSync(log, '')
  return { dir, log, path: `${bin}:${process.env.PATH}` }
}

const calls = log => readFileSync(log, 'utf8').split('\n').filter(Boolean)

function node(script, env) {
  return spawnSync(process.execPath, [join(action, script)], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })
}

// GITHUB_STATE lines -> STATE_* env, as the runner does
function stateEnv(file) {
  return Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    const index = line.indexOf('=')
    return [`STATE_${line.slice(0, index)}`, line.slice(index + 1)]
  }))
}

test('main records started services and post removes them', () => {
  const box = sandbox()
  const compose = join(box.dir, 'compose.yml')
  writeFileSync(compose, 'services: {}\n')
  const files = { GITHUB_OUTPUT: join(box.dir, 'out'), GITHUB_STATE: join(box.dir, 'state') }
  const main = node('index.mjs', {
    ...files, PATH: box.path,
    'INPUT_POSTGRES-VERSION': '18', 'INPUT_POSTGRES-USER': 'u', 'INPUT_POSTGRES-PASSWORD': 'p w', 'INPUT_POSTGRES-DB': 'db',
    'INPUT_POSTGRES-PORT': '5432', 'INPUT_MAILPIT-VERSION': 'v1.30', 'INPUT_MAILPIT-HTTP-PORT': '8025', 'INPUT_MAILPIT-SMTP-PORT': '1025',
    'INPUT_COMPOSE-FILE': compose, 'INPUT_WAIT-SECONDS': '5', 'INPUT_NAME-SUFFIX': 'Run 1',
  })
  assert.equal(main.status, 0, main.stdout + main.stderr)
  const outputs = readFileSync(files.GITHUB_OUTPUT, 'utf8')
  assert.match(outputs, /^database-url=postgresql:\/\/u:p%20w@127\.0\.0\.1:5432\/db$/m)
  assert.match(outputs, /^postgres-container=ci-postgres-run-1$/m)
  assert.match(outputs, /^compose-project=ci-run-1$/m)
  assert.deepEqual(stateEnv(files.GITHUB_STATE), {
    STATE_postgres_container: 'ci-postgres-run-1',
    STATE_mailpit_container: 'ci-mailpit-run-1',
    STATE_compose_project: 'ci-run-1',
    STATE_compose_file: compose,
  })

  writeFileSync(box.log, '')
  const post = node('post.mjs', { PATH: box.path, ...stateEnv(files.GITHUB_STATE) })
  assert.equal(post.status, 0, post.stdout + post.stderr)
  assert.deepEqual(calls(box.log), [
    `docker compose -p ci-run-1 -f ${compose} down --volumes --remove-orphans`,
    'docker rm --force --volumes ci-postgres-run-1 ci-mailpit-run-1',
  ])
})

test('a failed start still leaves state for cleanup', () => {
  const box = sandbox()
  const files = { GITHUB_OUTPUT: join(box.dir, 'out'), GITHUB_STATE: join(box.dir, 'state') }
  const main = node('index.mjs', { ...files, PATH: box.path, FAIL_DOCKER: '1', 'INPUT_POSTGRES-VERSION': '18', 'INPUT_POSTGRES-PORT': '5432', 'INPUT_NAME-SUFFIX': 'x' })
  assert.equal(main.status, 1)
  assert.deepEqual(stateEnv(files.GITHUB_STATE), { STATE_postgres_container: 'ci-postgres-x' })
})

test('post without a compose file on disk uses the project name only', () => {
  const box = sandbox()
  const post = node('post.mjs', { PATH: box.path, STATE_compose_project: 'ci-a', STATE_compose_file: join(box.dir, 'gone.yml') })
  assert.equal(post.status, 0)
  assert.deepEqual(calls(box.log), ['docker compose -p ci-a down --volumes --remove-orphans'])
})

test('post without state does nothing and docker failures only warn', () => {
  const box = sandbox()
  assert.equal(node('post.mjs', { PATH: box.path }).status, 0)
  assert.deepEqual(calls(box.log), [])

  const failed = node('post.mjs', { PATH: box.path, FAIL_DOCKER: '1', STATE_mailpit_container: 'ci-mailpit-x' })
  assert.equal(failed.status, 0)
  assert.match(failed.stdout, /::warning::docker rm --force --volumes ci-mailpit-x failed/)
  assert.deepEqual(calls(box.log), ['docker rm --force --volumes ci-mailpit-x'])
})

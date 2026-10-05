import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configFromInputs, DeployError, DokployDeployment, freshest, redact } from '../../.github/actions/dokploy-deploy/deploy.mjs'

const REVISION = 'a'.repeat(40)
const START = 1_700_000_000_000

// Minimal Dokploy: records writes, answers the endpoints the action uses.
class FakeDokploy {
  constructor({ deployStates = ['done'], health = () => ({ status: 'ok', revision: REVISION }), image = 'ghcr.io/x/app:old', applicationStatus = 'running' } = {}) {
    this.writes = []
    this.deployments = []
    this.deployStates = deployStates
    this.health = health
    this.image = image
    this.applicationStatus = applicationStatus
    this.clock = START
    this.queued = false
    this.pending = []
    // path -> error thrown by fetch, as a network failure or timeout would
    this.failures = new Map()
  }

  fetch = async (url, init = {}) => {
    assert.ok(init.signal instanceof AbortSignal, 'every request has a timeout')
    const target = String(url)
    if (target.startsWith('https://health')) {
      const body = this.health(this.image)
      return body === null
        ? new Response('down', { status: 503 })
        : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const path = new URL(target).pathname
    const failure = this.failures.get(path)
    if (failure) {
      this.writes.push(`fail ${path}`)
      throw failure
    }
    const body = init.body === undefined ? {} : JSON.parse(init.body)
    if (path === '/api/application.one') return this.json({ dockerImage: this.image, applicationStatus: this.applicationStatus })
    if (path === '/api/application.update') {
      this.writes.push(`image ${body.dockerImage}`)
      this.image = body.dockerImage
      return this.json({})
    }
    if (path === '/api/application.deploy') {
      this.writes.push(`deploy ${body.title}`)
      this.description = body.description
      const entry = { title: body.title, createdAt: new Date(this.clock).toISOString(), status: this.deployStates.shift() ?? 'done' }
      // Real Dokploy queues: the entry shows up only after the first poll
      if (this.queued) this.pending.push(entry)
      else this.deployments.push(entry)
      return this.json({})
    }
    if (path === '/api/application.stop') {
      this.writes.push('stop')
      return this.json({})
    }
    if (path === '/api/schedule.runManually') {
      this.writes.push('backup')
      this.deployments.push({ scheduleId: body.scheduleId, createdAt: new Date(this.clock).toISOString(), status: this.backupState ?? 'done' })
      return this.json({})
    }
    if (path === '/api/deployment.all' || path === '/api/deployment.allByType') {
      const response = this.json(this.deployments)
      this.deployments.push(...this.pending.splice(0))
      return response
    }
    throw new Error(`fake: unexpected ${path}`)
  }

  json(value) {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

function deployment(api, overrides = {}) {
  const config = {
    baseUrl: 'https://dokploy.example', apiKey: 'key', applicationId: 'app-1', project: 'demo', environment: 'stage',
    revision: REVISION, image: 'ghcr.io/x/app:new', healthUrl: 'https://health.example/api/health', description: 'test',
    timeoutMs: 1000, pollMs: 10, rollback: true, ...overrides,
  }
  let now = START
  let attempts = 0
  const logs = []
  const timeouts = []
  const run = new DokployDeployment(config, {
    fetch: api.fetch,
    pause: async (ms) => { now += ms },
    now: () => now,
    log: line => logs.push(line),
    attemptId: () => `a${++attempts}`,
    timeout: (ms) => {
      timeouts.push(ms)
      return AbortSignal.timeout(ms)
    },
  })
  run.logs = logs
  run.timeouts = timeouts
  return run
}

// Old image answers with another revision; the new one is broken.
const oldHealthy = image => (image.endsWith(':old') ? { status: 'ok', revision: 'c'.repeat(40) } : { status: 'ok', revision: 'b'.repeat(40) })

test('a healthy release sets the image, deploys and verifies the revision', async () => {
  const api = new FakeDokploy()
  const run = deployment(api)
  await run.deploy()
  assert.deepEqual(api.writes, ['image ghcr.io/x/app:new', `deploy demo stage ${REVISION} [a1]`])
  assert.equal(run.previousImage, 'ghcr.io/x/app:old')
  assert.equal(run.rolledBack, false)
})

test('an unhealthy release rolls the previous image back and verifies it answers', async () => {
  const api = new FakeDokploy({ health: oldHealthy })
  const run = deployment(api)
  await assert.rejects(run.deploy(), error => error.code === 'HEALTH_TIMEOUT')
  assert.deepEqual(api.writes, [
    'image ghcr.io/x/app:new', `deploy demo stage ${REVISION} [a1]`, 'image ghcr.io/x/app:old', `deploy demo stage ${REVISION} rollback [a2]`,
  ])
  assert.equal(api.image, 'ghcr.io/x/app:old')
  assert.equal(run.rolledBack, true)
})

test('a rollback that never answers is reported as an error', async () => {
  const api = new FakeDokploy({ health: () => null })
  const run = deployment(api)
  await assert.rejects(run.deploy(), error => error.code === 'HEALTH_TIMEOUT')
  assert.equal(run.rolledBack, false)
  assert.ok(run.logs.some(line => line.startsWith('::error::Rollback to ghcr.io/x/app:old failed')))
})

test('a failed Dokploy deployment rolls back too, and rollback can be switched off', async () => {
  const api = new FakeDokploy({ deployStates: ['error'], health: oldHealthy })
  await assert.rejects(deployment(api).deploy(), error => error.code === 'DEPLOYMENT_FAILED')
  assert.equal(api.image, 'ghcr.io/x/app:old')

  const plain = new FakeDokploy({ deployStates: ['error'] })
  await assert.rejects(deployment(plain, { rollback: false }).deploy(), error => error.code === 'DEPLOYMENT_FAILED')
  assert.deepEqual(plain.writes, ['image ghcr.io/x/app:new', `deploy demo stage ${REVISION} [a1]`])
})

test('a stale deployment entry is ignored, a fresh one is matched', async () => {
  const api = new FakeDokploy()
  api.deployments.push({ title: `demo stage ${REVISION}`, createdAt: new Date(START - 3_600_000).toISOString(), status: 'error' })
  await deployment(api).deploy()
  assert.ok(api.writes.includes(`deploy demo stage ${REVISION} [a1]`))
})

test('a retry ignores the previous attempt\'s recent failure while its own deployment is queued', async () => {
  const api = new FakeDokploy()
  api.queued = true
  api.deployments.push({ title: `demo stage ${REVISION} [a0]`, createdAt: new Date(START - 30_000).toISOString(), status: 'error' })
  const run = deployment(api)
  await run.deploy()
  assert.equal(run.rolledBack, false)
  assert.equal(api.image, 'ghcr.io/x/app:new')
})

test('freshest tolerates a Dokploy clock behind the runner and prefers the newest entry', () => {
  const at = offset => new Date(START + offset).toISOString()
  const list = [
    { title: 't', createdAt: at(-30_000), status: 'running' },
    { title: 't', createdAt: at(-90_000), status: 'error' },
    { title: 't', createdAt: at(-10_000), status: 'done' },
  ]
  assert.equal(freshest(list, entry => entry.title === 't', START).status, 'done')
  assert.equal(freshest(list.slice(1, 2), entry => entry.title === 't', START), undefined)
})

test('production refuses to deploy without a backup, and runs it first when given one', async () => {
  const api = new FakeDokploy()
  await assert.rejects(deployment(api, { environment: 'production' }).deploy(), error => error.code === 'BACKUP_SCHEDULE_REQUIRED')
  assert.deepEqual(api.writes, [], 'nothing is touched without a backup')

  const withBackup = new FakeDokploy()
  await deployment(withBackup, { environment: 'production', backupScheduleId: 'sched-1' }).deploy()
  assert.equal(withBackup.writes[0], 'backup', 'the backup runs before the image changes')
})

test('skip-backup lets a running production app deploy without a backup, with a warning', async () => {
  const api = new FakeDokploy()
  const run = deployment(api, { environment: 'production', skipBackup: true })
  await run.deploy()
  assert.equal(api.writes[0], 'image ghcr.io/x/app:new', 'no backup runs')
  assert.ok(run.logs.some(message => message.startsWith('::warning::')))
})

test('require-backup false lets production deploy without a schedule', async () => {
  const api = new FakeDokploy()
  const run = deployment(api, { environment: 'production', requireBackup: false })
  await run.deploy()
  assert.equal(api.writes[0], 'image ghcr.io/x/app:new', 'no backup runs')
  assert.ok(run.logs.includes('Backup not required for this application'))
})

test('first production release requires the exact idle bootstrap image to skip backup', async () => {
  const bootstrap = new FakeDokploy({ image: 'nginx:1.27-alpine', applicationStatus: 'idle' })
  await deployment(bootstrap, { environment: 'production', initialImage: 'nginx:1.27-alpine' }).deploy()
  assert.equal(bootstrap.writes[0], 'image ghcr.io/x/app:new')

  const running = new FakeDokploy({ image: 'nginx:1.27-alpine' })
  await assert.rejects(deployment(running, { environment: 'production', initialImage: 'nginx:1.27-alpine' }).deploy(), error => error.code === 'BACKUP_SCHEDULE_REQUIRED')
  assert.deepEqual(running.writes, [])

  const changed = new FakeDokploy({ image: 'ghcr.io/x/app:old', applicationStatus: 'idle' })
  await assert.rejects(deployment(changed, { environment: 'production', initialImage: 'nginx:1.27-alpine' }).deploy(), error => error.code === 'BACKUP_SCHEDULE_REQUIRED')
  assert.deepEqual(changed.writes, [])
})

test('a failing backup stops the release before the image changes', async () => {
  const api = new FakeDokploy()
  api.backupState = 'error'
  await assert.rejects(deployment(api, { environment: 'production', backupScheduleId: 'sched-1' }).deploy(), error => error.code === 'BACKUP_FAILED')
  assert.deepEqual(api.writes, ['backup'])
})

test('stop leaves the image alone', async () => {
  const api = new FakeDokploy()
  await deployment(api).stop()
  assert.deepEqual(api.writes, ['stop'])
})

test('placeholder deploy verifies idle health on preview', async () => {
  const api = new FakeDokploy({ health: () => ({ status: 'idle' }) })
  await deployment(api, { environment: 'preview', image: 'ghcr.io/x/preview-placeholder:1' }).placeholder()
  assert.deepEqual(api.writes, ['image ghcr.io/x/preview-placeholder:1', `deploy demo preview ${REVISION} [a1]`])
})

test('placeholder deploy rejects a stale app response and restores the previous image', async () => {
  const api = new FakeDokploy()
  await assert.rejects(deployment(api, { environment: 'preview' }).placeholder(), error => error.code === 'HEALTH_TIMEOUT')
  assert.equal(api.image, 'ghcr.io/x/app:old')
})

test('placeholder mode rejects non-preview environments before changing Dokploy', async () => {
  const api = new FakeDokploy({ health: () => ({ status: 'idle' }) })
  await assert.rejects(deployment(api, { environment: 'production' }).placeholder(), error => error.code === 'INPUT_INVALID')
  assert.deepEqual(api.writes, [])
})

test('an unreachable Dokploy is retried and then reported', async () => {
  let calls = 0
  const flaky = { fetch: async () => { calls += 1; throw new Error('connect ECONNREFUSED') } }
  await assert.rejects(deployment(flaky).deploy(), error => error.code === 'DOKPLOY_UNREACHABLE')
  assert.equal(calls, 3)
})

test('secrets never reach the output', () => {
  assert.equal(redact(new Error('GET https://d/?x-api-key=abc123 failed')), 'GET https://d/?x-api-key=[redacted] failed')
  assert.equal(redact(new Error('token=hunter2')), 'token=[redacted]')
})

test('inputs are validated before anything is called', () => {
  const base = {
    'dokploy-url': 'https://d', 'api-key': 'k', 'application-id': 'a', project: 'demo',
    environment: 'stage', revision: REVISION, image: 'i', 'health-url': 'https://h',
  }
  const config = inputs => configFromInputs(name => inputs[name] ?? '')
  assert.equal(config(base).rollback, true)
  assert.equal(config(base).requireBackup, true)
  assert.equal(config(base).timeoutMs, 600_000)
  assert.equal(config(base).description, `Revision ${REVISION}`)
  assert.equal(config({ ...base, description: 'x' }).description, 'x')
  assert.equal(config({ ...base, 'require-backup': 'false' }).requireBackup, false)
  assert.equal(config({ ...base, 'poll-ms': '250' }).pollMs, 250)
  for (const bad of [{ environment: 'prod' }, { revision: 'main' }, { 'dokploy-url': '' }, { 'timeout-ms': 'ten' },
    { 'poll-ms': '0' }, { 'timeout-ms': '1.5' }, { rollback: 'yes' }]) {
    assert.throws(() => config({ ...base, ...bad }), DeployError, JSON.stringify(bad))
  }
})

test('the backup request waits for the whole timeout, is not retried and blocks the deploy on timeout', async () => {
  const api = new FakeDokploy()
  api.failures.set('/api/schedule.runManually', new DOMException('The operation timed out', 'TimeoutError'))
  const run = deployment(api, { environment: 'production', backupScheduleId: 'sched-1', timeoutMs: 900_000 })
  await assert.rejects(run.deploy(), error => error.code === 'BACKUP_TIMEOUT')
  assert.deepEqual(api.writes, ['fail /api/schedule.runManually'], 'one backup attempt, no image change')
  assert.ok(run.timeouts.includes(900_000))
})

test('a deploy request that fails in transit is not sent again', async () => {
  const api = new FakeDokploy({ health: oldHealthy })
  api.failures.set('/api/application.deploy', new TypeError('fetch failed'))
  await assert.rejects(deployment(api, { rollback: false }).deploy(), error => error.code === 'DOKPLOY_UNREACHABLE')
  assert.deepEqual(api.writes, ['image ghcr.io/x/app:new', 'fail /api/application.deploy'])
})

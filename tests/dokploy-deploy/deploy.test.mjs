import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { configFromInputs, DeployError, DokployDeployment, freshest, redact } from '../../.github/actions/dokploy-deploy/deploy.mjs'

const REVISION = 'a'.repeat(40)
const START = 1_700_000_000_000

const fakes = []
afterEach(() => {
  for (const api of fakes.splice(0)) assert.deepEqual(api.violations, [], 'every request matches the Dokploy API contract')
})

// Answers each list poll with the current status, then advances along `states`.
function entry(fields, states) {
  const [status, ...next] = typeof states === 'string' ? [states] : states
  return { ...fields, status, next }
}

// Minimal Dokploy: checks every request against the API contract, records writes and polls.
class FakeDokploy {
  constructor({
    deployStates = ['done'], backupStates = ['done'], health = () => ({ status: 'ok', revision: REVISION }), unhealthy = 0,
    image = 'ghcr.io/x/app:old', applicationStatus = 'running', apiKey = 'key', applicationId = 'app-1', scheduleId = 'sched-1',
  } = {}) {
    this.writes = []
    this.events = []
    this.healthChecks = []
    this.violations = []
    this.deployments = []
    this.deployStates = deployStates
    this.backupStates = backupStates
    this.health = health
    this.unhealthy = unhealthy
    this.image = image
    this.applicationStatus = applicationStatus
    this.expected = { apiKey, applicationId, scheduleId }
    this.clock = START
    this.queued = false
    this.pending = []
    // path -> error thrown by fetch, as a network failure or timeout would
    this.failures = new Map()
    fakes.push(this)
  }

  // Production code swallows fetch errors into retries, so mismatches are also recorded.
  expect(condition, message) {
    if (condition) return
    this.violations.push(message)
    throw new Error(`fake: ${message}`)
  }

  fetch = async (url, init = {}) => {
    assert.ok(init.signal instanceof AbortSignal, 'every request has a timeout')
    const target = new URL(String(url))
    const method = init.method ?? 'GET'
    const headers = new Headers(init.headers)
    if (target.origin === 'https://health.example') {
      this.expect(method === 'GET' && target.pathname === '/api/health', `health ${method} ${target.pathname}`)
      this.expect(!headers.has('x-api-key'), 'health check must not carry the Dokploy key')
      this.healthChecks.push(this.image)
      this.events.push(`health ${this.image}`)
      if (this.unhealthy > 0) {
        this.unhealthy -= 1
        return new Response('starting', { status: 503 })
      }
      const body = this.health(this.image)
      return body === null
        ? new Response('down', { status: 503 })
        : this.json(body)
    }
    this.expect(target.origin === 'https://dokploy.example', `unexpected origin ${target.origin}`)
    this.expect(headers.get('x-api-key') === this.expected.apiKey, `${target.pathname} without the x-api-key`)
    const path = target.pathname
    const query = Object.fromEntries(target.searchParams)
    const body = init.body === undefined ? {} : JSON.parse(init.body)
    const route = (expectedMethod, check) => {
      this.expect(method === expectedMethod, `${path} expects ${expectedMethod}, got ${method}`)
      if (expectedMethod === 'GET') this.expect(init.body === undefined, `${path} GET with a body`)
      this.expect(check(), `${path} with query ${JSON.stringify(query)} body ${JSON.stringify(body)}`)
    }
    const app = this.expected.applicationId
    const failure = this.failures.get(path)
    if (failure) {
      this.writes.push(`fail ${path}`)
      this.events.push(`fail ${path}`)
      throw failure
    }
    if (path === '/api/application.one') {
      route('GET', () => query.applicationId === app)
      return this.json({ dockerImage: this.image, applicationStatus: this.applicationStatus })
    }
    if (path === '/api/application.update') {
      route('POST', () => body.applicationId === app && typeof body.dockerImage === 'string')
      this.write(`image ${body.dockerImage}`)
      this.image = body.dockerImage
      return this.json({})
    }
    if (path === '/api/application.deploy') {
      route('POST', () => body.applicationId === app && typeof body.title === 'string')
      this.write(`deploy ${body.title}`)
      this.description = body.description
      const created = entry({ title: body.title, createdAt: new Date(this.clock).toISOString() }, this.deployStates.shift() ?? 'done')
      // Real Dokploy queues: the entry shows up only after the first poll
      if (this.queued) this.pending.push(created)
      else this.deployments.push(created)
      return this.json({})
    }
    if (path === '/api/application.stop') {
      route('POST', () => body.applicationId === app)
      this.write('stop')
      return this.json({})
    }
    if (path === '/api/schedule.runManually') {
      route('POST', () => body.scheduleId === this.expected.scheduleId)
      this.write('backup')
      this.deployments.push(entry({ scheduleId: body.scheduleId, createdAt: new Date(this.clock).toISOString() }, this.backupStates))
      return this.json({})
    }
    if (path === '/api/deployment.all') {
      route('GET', () => query.applicationId === app)
      return this.poll('deployment', item => item.scheduleId === undefined)
    }
    if (path === '/api/deployment.allByType') {
      route('GET', () => query.id === this.expected.scheduleId && query.type === 'schedule')
      return this.poll('backup', item => item.scheduleId === query.id)
    }
    this.expect(false, `unexpected ${method} ${path}`)
  }

  write(line) {
    this.writes.push(line)
    this.events.push(line)
  }

  poll(kind, filter) {
    const list = this.deployments.filter(filter)
    const response = this.json(list.map(({ next, ...item }) => item))
    this.events.push(`poll ${kind} ${list.map(item => item.status).join(',')}`)
    for (const item of list) if (item.next.length > 0) item.status = item.next.shift()
    this.deployments.push(...this.pending.splice(0))
    return response
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
  const api = new FakeDokploy({ deployStates: [['running', 'running', 'done']], unhealthy: 2 })
  const run = deployment(api)
  await run.deploy()
  assert.deepEqual(api.events, [
    'image ghcr.io/x/app:new', `deploy demo stage ${REVISION} [a1]`,
    'poll deployment running', 'poll deployment running', 'poll deployment done',
    'health ghcr.io/x/app:new', 'health ghcr.io/x/app:new', 'health ghcr.io/x/app:new',
  ], 'health is polled until the new revision answers')
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
  api.queued = true
  api.deployments.push(entry({ title: `demo stage ${REVISION} [a1]`, createdAt: new Date(START - 3_600_000).toISOString() }, 'error'))
  const run = deployment(api)
  await run.deploy()
  assert.equal(run.rolledBack, false)
  assert.deepEqual(api.events.filter(event => event.startsWith('poll')), ['poll deployment error', 'poll deployment error,done'])
})

test('a retry ignores the previous attempt\'s recent failure while its own deployment is queued', async () => {
  const api = new FakeDokploy()
  api.queued = true
  api.deployments.push(entry({ title: `demo stage ${REVISION} [a0]`, createdAt: new Date(START - 30_000).toISOString() }, 'error'))
  const run = deployment(api)
  await run.deploy()
  assert.equal(run.rolledBack, false)
  assert.deepEqual(api.events.filter(event => event.startsWith('poll')), ['poll deployment error', 'poll deployment error,done'])
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

  const withBackup = new FakeDokploy({ backupStates: ['running', 'running', 'done'] })
  await deployment(withBackup, { environment: 'production', backupScheduleId: 'sched-1' }).deploy()
  assert.deepEqual(withBackup.events.slice(0, 5), [
    'backup', 'poll backup running', 'poll backup running', 'poll backup done', 'image ghcr.io/x/app:new',
  ], 'the image changes only after the backup is done')
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
  const api = new FakeDokploy({ backupStates: ['running', 'error'] })
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
  assert.deepEqual(api.healthChecks, ['ghcr.io/x/preview-placeholder:1'])
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

test('the configured api key never reaches logs or errors of a failed deploy', async () => {
  const apiKey = 'dk_live_8f3a1c'
  const api = new FakeDokploy({ apiKey })
  const leak = () => new TypeError(`fetch failed: https://dokploy.example/api/application.update?token=${apiKey} (header x-api-key: ${apiKey})`)
  api.failures.set('/api/application.update', leak())
  const run = deployment(api, { apiKey })
  const error = await run.deploy().then(() => assert.fail('deploy succeeded'), cause => cause)
  assert.equal(error.code, 'DOKPLOY_UNREACHABLE')
  assert.ok(run.logs.some(line => line.startsWith('::error::Rollback to ghcr.io/x/app:old failed')), 'the rollback failure is logged')
  const output = [...run.logs, error.message, redact(error, [apiKey])].join('\n')
  assert.match(output, /token=\[redacted\]/u)
  assert.doesNotMatch(output, new RegExp(apiKey, 'u'))
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

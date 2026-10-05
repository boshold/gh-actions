// Deploys one image to a Dokploy application and proves the running revision.
import { randomBytes } from 'node:crypto'

const TERMINAL = new Set(['done', 'error'])
const SHA = /^[0-9a-f]{40}$/u
const SECRET = /(x-api-key|authorization|token|password)=[^&\s]+/giu
// Dokploy and runner clocks drift; entries this much older than our request still count.
const CLOCK_SKEW_MS = 60_000
const REQUEST_TIMEOUT_MS = 30_000
const HEALTH_TIMEOUT_MS = 10_000

export class DeployError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DeployError'
    this.code = code
  }
}

export function redact(value) {
  const message = value instanceof Error ? value.message : String(value)
  return message.replaceAll(SECRET, '$1=[redacted]')
}

function asArray(payload, what) {
  const list = Array.isArray(payload) ? payload : (payload?.deployments ?? payload?.data)
  if (!Array.isArray(list)) throw new DeployError('DOKPLOY_INVALID_RESPONSE', `Dokploy returned an invalid ${what} list`)
  return list
}

function stateOf(entry) {
  return typeof entry?.status === 'string' ? entry.status : (typeof entry?.state === 'string' ? entry.state : undefined)
}

function createdAt(entry) {
  return Date.parse(entry?.createdAt ?? '')
}

// Newest entry matching `filter` created after `startedAt` (minus clock skew).
export function freshest(list, filter, startedAt) {
  return list
    .filter(entry => filter(entry) && Number.isFinite(createdAt(entry)) && createdAt(entry) >= startedAt - CLOCK_SKEW_MS)
    .sort((a, b) => createdAt(b) - createdAt(a))[0]
}

export class DokployDeployment {
  constructor(config, deps = {}) {
    this.config = config
    this.fetch = deps.fetch ?? globalThis.fetch
    this.pause = deps.pause ?? (ms => new Promise((resolve) => { setTimeout(resolve, ms) }))
    this.now = deps.now ?? (() => Date.now())
    this.log = deps.log ?? (line => { process.stdout.write(`${line}\n`) })
    this.attemptId = deps.attemptId ?? (() => randomBytes(4).toString('hex'))
    this.previousImage = null
    this.rolledBack = false
  }

  // Unique per attempt, so a retry never matches an earlier attempt's entry
  title(kind = '') {
    return `${this.config.project} ${this.config.environment} ${this.config.revision}${kind} [${this.attemptId()}]`
  }

  async request(path, method, body) {
    let response
    for (let attempt = 1; ; attempt += 1) {
      try {
        response = await this.fetch(new URL(path, this.config.baseUrl), {
          method,
          headers: { 'x-api-key': this.config.apiKey, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (error) {
        if (attempt >= 3) throw new DeployError('DOKPLOY_UNREACHABLE', redact(error))
        await this.pause(this.config.pollMs)
        continue
      }
      if (response.status >= 500 && attempt < 3) {
        await this.pause(this.config.pollMs)
        continue
      }
      break
    }
    if (!response.ok) throw new DeployError('DOKPLOY_REQUEST_FAILED', `${method} ${path} failed with ${response.status}`)
    const text = await response.text()
    return text === '' ? null : JSON.parse(text)
  }

  async currentApplication() {
    const application = await this.request(`/api/application.one?applicationId=${encodeURIComponent(this.config.applicationId)}`, 'GET')
    const image = application?.dockerImage
    return {
      image: typeof image === 'string' && image !== '' ? image : null,
      status: typeof application?.applicationStatus === 'string' ? application.applicationStatus : null,
    }
  }

  async setImage(image) {
    await this.request('/api/application.update', 'POST', { applicationId: this.config.applicationId, dockerImage: image })
  }

  async startDeployment(title) {
    const startedAt = this.now()
    await this.request('/api/application.deploy', 'POST', { applicationId: this.config.applicationId, title, description: this.config.description })
    return startedAt
  }

  async waitForDeployment(title, startedAt) {
    const deadline = this.now() + this.config.timeoutMs
    while (this.now() <= deadline) {
      const list = asArray(await this.request(`/api/deployment.all?applicationId=${encodeURIComponent(this.config.applicationId)}`, 'GET'), 'deployment')
      const state = stateOf(freshest(list, entry => entry?.title === title, startedAt))
      if (state === 'done') return
      if (state !== undefined && TERMINAL.has(state)) throw new DeployError('DEPLOYMENT_FAILED', 'Dokploy reported a failed deployment')
      await this.pause(this.config.pollMs)
    }
    throw new DeployError('DEPLOYMENT_TIMEOUT', 'Timed out waiting for the Dokploy deployment')
  }

  // The application must report the expected body, not merely answer.
  async waitForHealth(accept, what) {
    const deadline = this.now() + this.config.timeoutMs
    let last = 'no response yet'
    while (this.now() <= deadline) {
      try {
        const response = await this.fetch(this.config.healthUrl, { method: 'GET', signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
        if (response.ok) {
          const body = await response.json()
          if (accept(body)) return
          last = `status=${String(body?.status)} revision=${String(body?.revision)}`
        } else {
          last = `HTTP ${response.status}`
        }
      } catch (error) {
        last = redact(error)
      }
      await this.pause(this.config.pollMs)
    }
    throw new DeployError('HEALTH_TIMEOUT', `Timed out waiting for ${what} health (last: ${last})`)
  }

  async runBackup(scheduleId) {
    const startedAt = this.now()
    await this.request('/api/schedule.runManually', 'POST', { scheduleId })
    const deadline = this.now() + this.config.timeoutMs
    while (this.now() <= deadline) {
      const list = asArray(await this.request(`/api/deployment.allByType?id=${encodeURIComponent(scheduleId)}&type=schedule`, 'GET'), 'schedule deployment')
      const state = stateOf(freshest(list, entry => entry?.scheduleId === scheduleId, startedAt))
      if (state === 'done') return
      if (state !== undefined && TERMINAL.has(state)) throw new DeployError('BACKUP_FAILED', 'Dokploy reported a failed backup')
      await this.pause(this.config.pollMs)
    }
    throw new DeployError('BACKUP_TIMEOUT', 'Timed out waiting for the Dokploy backup')
  }

  async deploy(expectedStatus = 'ok') {
    const current = await this.currentApplication()
    this.previousImage = current.image
    if (this.config.environment === 'production' && this.config.backupScheduleId === undefined) {
      if (this.config.requireBackup === false) {
        this.log('Backup not required for this application')
      } else if (this.config.skipBackup === true) {
        this.log('::warning::Production deploys without a backup (skip-backup)')
      } else if (this.config.initialImage === undefined || current.image !== this.config.initialImage || current.status !== 'idle') {
        throw new DeployError('BACKUP_SCHEDULE_REQUIRED', 'A production deployment needs a backup schedule')
      } else {
        this.log('Initial release from idle bootstrap; backup skipped')
      }
    }
    if (this.config.backupScheduleId !== undefined) {
      this.log('Running the pre-deployment backup')
      await this.runBackup(this.config.backupScheduleId)
    }
    const accept = expectedStatus === 'idle'
      ? body => body?.status === 'idle'
      : body => body?.status === 'ok' && body?.revision === this.config.revision
    try {
      await this.setImage(this.config.image)
      this.log(`Deploying ${this.config.image}`)
      const title = this.title()
      await this.waitForDeployment(title, await this.startDeployment(title))
      await this.waitForHealth(accept, expectedStatus)
      this.log(expectedStatus === 'idle' ? 'Preview placeholder is healthy' : `Revision ${this.config.revision} is healthy`)
    } catch (error) {
      await this.rollback(this.previousImage, error)
      throw error
    }
  }

  async placeholder() {
    if (this.config.environment !== 'preview') {
      throw new DeployError('INPUT_INVALID', 'Placeholder mode is only allowed for preview')
    }
    await this.deploy('idle')
  }

  // Put the image that was serving back and prove it answers again (any revision, or the idle placeholder).
  async rollback(previous, cause) {
    if (!this.config.rollback || previous === null || previous === this.config.image) return
    this.log(`Rolling back to ${previous} after ${redact(cause)}`)
    try {
      await this.setImage(previous)
      const title = this.title(' rollback')
      await this.waitForDeployment(title, await this.startDeployment(title))
      await this.waitForHealth(body => body?.status === 'ok' || body?.status === 'idle', 'rollback')
      this.rolledBack = true
      this.log(`Rolled back to ${previous}`)
    } catch (error) {
      this.log(`::error::Rollback to ${previous} failed: ${redact(error)}`)
    }
  }

  async stop() {
    await this.request('/api/application.stop', 'POST', { applicationId: this.config.applicationId })
    this.log('Application stopped')
  }
}

// `get(name)` returns the trimmed input value or ''.
export function configFromInputs(get) {
  const required = (name) => {
    const value = get(name)
    if (value === '') throw new DeployError('INPUT_MISSING', `${name} is required`)
    return value
  }
  const positive = (name, fallback) => {
    const raw = get(name)
    const value = raw === '' ? fallback : Number(raw)
    if (!Number.isSafeInteger(value) || value <= 0) throw new DeployError('INPUT_INVALID', `${name} must be a positive integer, got "${raw}"`)
    return value
  }
  const flag = (name, fallback) => {
    const value = get(name)
    if (value === '') return fallback
    if (value !== 'true' && value !== 'false') throw new DeployError('INPUT_INVALID', `${name} must be true or false`)
    return value === 'true'
  }
  const environment = required('environment')
  if (!['preview', 'stage', 'production'].includes(environment)) {
    throw new DeployError('INPUT_INVALID', 'environment must be preview, stage or production')
  }
  const revision = required('revision')
  if (!SHA.test(revision)) throw new DeployError('INPUT_INVALID', 'revision must be a full commit sha')
  const schedule = get('backup-schedule-id')
  const initialImage = get('initial-image')
  return {
    baseUrl: required('dokploy-url'),
    apiKey: required('api-key'),
    applicationId: required('application-id'),
    project: required('project'),
    environment,
    revision,
    image: required('image'),
    healthUrl: required('health-url'),
    description: get('description') || `Revision ${revision}`,
    timeoutMs: positive('timeout-ms', 600_000),
    pollMs: positive('poll-ms', 5_000),
    rollback: flag('rollback', true),
    skipBackup: flag('skip-backup', false),
    requireBackup: flag('require-backup', true),
    ...(schedule === '' ? {} : { backupScheduleId: schedule }),
    ...(initialImage === '' ? {} : { initialImage }),
  }
}

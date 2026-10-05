import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fail, input, run } from '../_lib/core.mjs'

const env = {
  POSTGRES_VERSION: 'postgres-version',
  POSTGRES_MODE: 'postgres-mode',
  POSTGRES_USER: 'postgres-user',
  POSTGRES_PASSWORD: 'postgres-password',
  POSTGRES_DB: 'postgres-db',
  POSTGRES_PORT: 'postgres-port',
  POSTGRES_EXTRA_DATABASES: 'postgres-extra-databases',
  MAILPIT_VERSION: 'mailpit-version',
  MAILPIT_SMTP_PORT: 'mailpit-smtp-port',
  MAILPIT_HTTP_PORT: 'mailpit-http-port',
  COMPOSE_FILE_INPUT: 'compose-file',
  WAIT_SECONDS: 'wait-seconds',
  NAME_SUFFIX: 'name-suffix',
}

await run(async () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'start.sh')
  const mapped = Object.fromEntries(Object.entries(env).map(([key, name]) => [key, input(name)]))
  const result = spawnSync('bash', [script], { stdio: 'inherit', env: { ...process.env, ...mapped } })
  if (result.error) throw result.error
  if (result.status !== 0) fail(`start.sh exited with ${result.status ?? result.signal}`)
})

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { info, run, warning } from '../_lib/core.mjs'

const state = name => (process.env[`STATE_${name}`] ?? '').trim()

function docker(args) {
  info(`docker ${args.join(' ')}`)
  const result = spawnSync('docker', args, { stdio: 'inherit' })
  if (result.error || result.status !== 0) warning(`docker ${args.join(' ')} failed (${result.error?.message ?? result.status})`)
}

// Best effort: never fails the job.
await run(async () => {
  const project = state('compose_project')
  if (project) {
    const file = state('compose_file')
    docker(['compose', '-p', project, ...(file && existsSync(file) ? ['-f', file] : []), 'down', '--volumes', '--remove-orphans'])
  }
  const containers = [state('postgres_container'), state('mailpit_container')].filter(Boolean)
  if (containers.length > 0) docker(['rm', '--force', '--volumes', ...containers])
})

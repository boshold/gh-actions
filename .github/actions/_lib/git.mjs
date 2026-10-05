import { execFileSync } from 'node:child_process'

function exec(args, env = process.env) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim()
  } catch (cause) {
    const stderr = String(cause.stderr ?? '').trim()
    throw new Error(`git ${args.join(' ')} failed (exit ${cause.status ?? 'unknown'})${stderr ? `: ${stderr}` : ''}`)
  }
}

export function git(...args) {
  return exec(args)
}

export function gitTry(...args) {
  try {
    return git(...args)
  } catch {
    return null
  }
}

export function basicAuth(token) {
  return Buffer.from(`x-access-token:${token}`).toString('base64')
}

// The auth header travels only in this child's env (GIT_CONFIG_*), never argv or
// GIT_CONFIG_PARAMETERS; hooks are disabled so repository code cannot read it.
// Empty values reset inherited extraheaders (incl. actions/checkout's URL-scoped one). The header goes on the
// URL-scoped key: git applies URL-specific values after the generic key, so a URL reset would drop a generic header.
export function tokenGitInvocation(token, args, { env = process.env, serverUrl = env.GITHUB_SERVER_URL || 'https://github.com' } = {}) {
  const scoped = `http.${serverUrl.replace(/\/*$/, '/')}.extraheader`
  const entries = [
    ['http.extraheader', ''],
    [scoped, ''],
    [scoped, `AUTHORIZATION: basic ${basicAuth(token)}`],
  ]
  // git reads GIT_CONFIG_PARAMETERS after GIT_CONFIG_COUNT, so inherited headers there would survive the resets
  const { GIT_CONFIG_PARAMETERS: _, ...inherited } = env
  const start = Number.parseInt(env.GIT_CONFIG_COUNT ?? '', 10) || 0
  const config = Object.fromEntries(entries.flatMap(([key, value], index) => [
    [`GIT_CONFIG_KEY_${start + index}`, key],
    [`GIT_CONFIG_VALUE_${start + index}`, value],
  ]))
  return {
    args: ['-c', 'core.hooksPath=/dev/null', ...args],
    env: { ...inherited, ...config, GIT_CONFIG_COUNT: String(start + entries.length), GIT_TERMINAL_PROMPT: '0' },
  }
}

export function gitWithToken(token, ...args) {
  const { args: argv, env } = tokenGitInvocation(token, args)
  return exec(argv, env)
}

import { execFileSync } from 'node:child_process'

export function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
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
// Empty values reset extraheaders inherited from config (incl. actions/checkout's URL-scoped one).
export function tokenGitInvocation(token, args, { env = process.env, serverUrl = env.GITHUB_SERVER_URL || 'https://github.com' } = {}) {
  const entries = [
    ['http.extraheader', ''],
    [`http.${serverUrl.replace(/\/*$/, '/')}.extraheader`, ''],
    ['http.extraheader', `AUTHORIZATION: basic ${basicAuth(token)}`],
  ]
  const start = Number.parseInt(env.GIT_CONFIG_COUNT ?? '', 10) || 0
  const config = Object.fromEntries(entries.flatMap(([key, value], index) => [
    [`GIT_CONFIG_KEY_${start + index}`, key],
    [`GIT_CONFIG_VALUE_${start + index}`, value],
  ]))
  return {
    args: ['-c', 'core.hooksPath=/dev/null', ...args],
    env: { ...env, ...config, GIT_CONFIG_COUNT: String(start + entries.length), GIT_TERMINAL_PROMPT: '0' },
  }
}

export function gitWithToken(token, ...args) {
  const { args: argv, env } = tokenGitInvocation(token, args)
  return execFileSync('git', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim()
}

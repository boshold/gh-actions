import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { basicAuth, tokenGitInvocation } from '../../.github/actions/_lib/git.mjs'

const TOKEN = 'ghs_secret'

test('the token reaches git only through env config, with hooks disabled', () => {
  const { args, env } = tokenGitInvocation(TOKEN, ['push', 'origin'], { env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' }, serverUrl: 'https://github.com' })
  assert.deepEqual(args, ['-c', 'core.hooksPath=/dev/null', 'push', 'origin'])
  assert.ok(!args.join(' ').includes(basicAuth(TOKEN)))
  assert.equal(env.GIT_CONFIG_PARAMETERS, undefined)
  assert.deepEqual(
    [env.GIT_CONFIG_COUNT, env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_VALUE_1, env.GIT_CONFIG_KEY_2, env.GIT_CONFIG_KEY_3],
    ['4', 'a.b', 'http.extraheader', '', 'http.https://github.com/.extraheader', 'http.extraheader'],
  )
  assert.equal(env.GIT_CONFIG_VALUE_3, `AUTHORIZATION: basic ${basicAuth(TOKEN)}`)
})

test('a pre-push hook in the repository never runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-token-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } })
  git('init', '--quiet', '--bare', 'remote.git')
  git('init', '--quiet', '--initial-branch', 'main', 'work')
  const work = join(dir, 'work')
  writeFileSync(join(work, 'a'), 'a')
  execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@x', 'add', '.'])
  execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@x', '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'a'])
  const leak = join(dir, 'leak')
  writeFileSync(join(work, '.git/hooks/pre-push'), `#!/bin/sh\nenv > ${leak}\n`)
  chmodSync(join(work, '.git/hooks/pre-push'), 0o755)

  const { args, env } = tokenGitInvocation(TOKEN, ['-C', work, 'push', '--quiet', join(dir, 'remote.git'), 'main'], { env: process.env })
  execFileSync('git', args, { env, stdio: 'ignore' })
  assert.equal(existsSync(leak), false)
  assert.equal(execFileSync('git', ['-C', join(dir, 'remote.git'), 'rev-parse', 'main'], { encoding: 'utf8' }).trim().length, 40)
})

import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { basicAuth, gitWithToken, tokenGitInvocation } from '../../.github/actions/_lib/git.mjs'

const TOKEN = 'ghs_secret'

test('the token reaches git only through env config, with hooks disabled', () => {
  const inherited = {
    GIT_CONFIG_PARAMETERS: "'http.extraheader'='AUTHORIZATION: basic stale'",
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c', GIT_CONFIG_KEY_1: 'd.e', GIT_CONFIG_VALUE_1: 'f',
  }
  const { args, env } = tokenGitInvocation(TOKEN, ['push', 'origin'], { env: inherited, serverUrl: 'https://github.com' })
  assert.deepEqual(args, ['-c', 'core.hooksPath=/dev/null', 'push', 'origin'])
  assert.ok(!args.join(' ').includes(basicAuth(TOKEN)))
  assert.equal(env.GIT_CONFIG_PARAMETERS, undefined, 'git applies it after GIT_CONFIG_COUNT, so it could override the reset')
  assert.equal(env.GIT_CONFIG_COUNT, '5')
  assert.deepEqual(
    [0, 1, 2, 3, 4].map(index => [env[`GIT_CONFIG_KEY_${index}`], env[`GIT_CONFIG_VALUE_${index}`]]),
    [
      ['a.b', 'c'], ['d.e', 'f'],
      ['http.extraheader', ''], ['http.https://github.com/.extraheader', ''],
      ['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${basicAuth(TOKEN)}`],
    ],
    'inherited entries stay, resets come before the header',
  )
})

test('only the server host gets the token, inherited headers are dropped', async () => {
  const seen = []
  const server = createServer((request, response) => {
    const auth = request.rawHeaders.filter((_, index) => index % 2 === 1 && request.rawHeaders[index - 1].toLowerCase() === 'authorization')
    seen.push({ host: request.headers.host.split(':')[0], auth })
    response.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  const inherited = {
    PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_PARAMETERS: "'http.extraheader'='AUTHORIZATION: basic stale-parameters'",
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic stale-count',
  }
  const lsRemote = host => new Promise((resolve) => {
    const { args, env } = tokenGitInvocation(TOKEN, ['ls-remote', `http://${host}:${port}/o/r.git`], { env: inherited, serverUrl: `http://127.0.0.1:${port}` })
    execFile('git', args, { env }, () => resolve())
  })
  try {
    await lsRemote('127.0.0.1')
    await lsRemote('localhost')
  }
  finally {
    server.close()
  }
  assert.deepEqual([...new Set(seen.map(request => request.host))], ['127.0.0.1', 'localhost'])
  for (const { host, auth } of seen) {
    assert.deepEqual(auth, host === '127.0.0.1' ? [`basic ${basicAuth(TOKEN)}`] : [], host)
  }
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

test('the header survives the resets in effective git config', () => {
  const { env } = tokenGitInvocation(TOKEN, [], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, serverUrl: 'https://github.com' })
  const effective = execFileSync('git', ['config', '--get-urlmatch', 'http.extraheader', 'https://github.com/o/r.git'], { env, encoding: 'utf8' })
  assert.equal(effective.trim(), `AUTHORIZATION: basic ${basicAuth(TOKEN)}`)
})

test('git failures carry stderr', () => {
  assert.throws(() => gitWithToken(TOKEN, 'ls-remote', '/nonexistent/repo.git'), /git -c core\.hooksPath=\/dev\/null ls-remote \/nonexistent\/repo\.git failed \(exit 128\): .*nonexistent/s)
})

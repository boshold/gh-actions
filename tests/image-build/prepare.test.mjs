import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const script = join(import.meta.dirname, '../../.github/actions/image-build/prepare.sh')
const context = join(import.meta.dirname, '../fixtures/app')

// Runs prepare.sh with the env image-build maps from its inputs; returns status and outputs.
function prepare(env) {
  const output = join(mkdtempSync(join(tmpdir(), 'image-build-')), 'out')
  const run = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'Owner/Repo', CONTEXT: context, REVISION: 'abc', ...env },
  })
  let outputs = ''
  try {
    outputs = readFileSync(output, 'utf8')
  }
  catch {}
  return { status: run.status, log: run.stdout + run.stderr, outputs }
}

// The input combinations nuxt-ci.yml and release-image.yml pass to image-build
const callers = {
  'nuxt-ci digest push': { TAGS: '', PUSH: 'false', PUSH_BY_DIGEST: 'true', LOAD: 'false', PLATFORMS: 'linux/amd64,linux/arm64' },
  'nuxt-ci load': { TAGS: 'pr-12', PUSH: 'false', PUSH_BY_DIGEST: 'false', LOAD: 'true' },
  'release-image digest push': { TAGS: '', PUSH: 'false', PUSH_BY_DIGEST: 'true', LOAD: 'false', VERSION: '1.2.3' },
  'release-image dry run': { TAGS: 'sha-abc', PUSH: 'false', PUSH_BY_DIGEST: 'false', LOAD: 'true', VERSION: '1.2.3' },
}

for (const [name, env] of Object.entries(callers)) {
  test(`accepts the ${name} inputs`, () => {
    const result = prepare(env)
    assert.equal(result.status, 0, result.log)
    if (env.PUSH_BY_DIGEST === 'true') {
      assert.match(result.outputs, /^outputs=type=image,name=ghcr\.io\/owner\/repo,push-by-digest=true,name-canonical=true,push=true$/m)
      assert.match(result.outputs, /^push=false$/m)
      assert.match(result.outputs, /^load=false$/m)
    }
    else {
      assert.match(result.outputs, /^load=true$/m)
    }
  })
}

test('digest push rejects tags and load', () => {
  assert.equal(prepare({ PUSH_BY_DIGEST: 'true', TAGS: 'pr-1' }).status, 1)
  assert.equal(prepare({ PUSH_BY_DIGEST: 'true', LOAD: 'true' }).status, 1)
})

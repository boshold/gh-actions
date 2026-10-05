import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const script = join(import.meta.dirname, '../../.github/actions/image-build/prepare.sh')
const context = join(import.meta.dirname, '../fixtures/app')
const IMAGE = 'ghcr.io/owner/repo'

// GITHUB_OUTPUT format: `name=value` lines and `name<<DELIM` heredocs.
function parseOutputs(text) {
  const outputs = {}
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === '') continue
    const heredoc = /^([^=<]+)<<(.+)$/u.exec(line)
    if (heredoc) {
      const [, name, delimiter] = heredoc
      const end = lines.indexOf(delimiter, i + 1)
      assert.ok(end > i, `unterminated heredoc for ${name}`)
      outputs[name] = lines.slice(i + 1, end).join('\n')
      i = end
      continue
    }
    const eq = line.indexOf('=')
    assert.ok(eq > 0, `malformed output line: ${line}`)
    outputs[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return outputs
}

// Runs prepare.sh with the env image-build maps from its inputs; returns status and parsed outputs.
function prepare(env) {
  const output = join(mkdtempSync(join(tmpdir(), 'image-build-')), 'out')
  const run = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'Owner/Repo', CONTEXT: context, REVISION: 'abc', ...env },
  })
  let text = ''
  try {
    text = readFileSync(output, 'utf8')
  }
  catch {}
  return { status: run.status, log: run.stdout + run.stderr, outputs: parseOutputs(text) }
}

const DIGEST_OUTPUTS = `type=image,name=${IMAGE},push-by-digest=true,name-canonical=true,push=true`
const REVISION_LABELS = ['org.opencontainers.image.revision=abc', 'org.opencontainers.image.source=https://github.com/Owner/Repo']

// The input combinations nuxt-ci.yml and release-image.yml pass to image-build
const callers = [
  {
    name: 'nuxt-ci digest push',
    env: { TAGS: '', PUSH: 'false', PUSH_BY_DIGEST: 'true', LOAD: 'false', PLATFORMS: 'linux/amd64,linux/arm64', PROVENANCE: 'min', SBOM: 'true' },
    expected: {
      push: 'false', load: 'false', tags: '', outputs: DIGEST_OUTPUTS, provenance: 'mode=min', sbom: 'true',
      'build-args': 'DEPLOYMENT_REVISION=abc', labels: REVISION_LABELS.join('\n'),
    },
  },
  {
    name: 'nuxt-ci load',
    env: { TAGS: 'pr-12', PUSH: 'false', PUSH_BY_DIGEST: 'false', LOAD: 'true', PROVENANCE: 'min' },
    expected: {
      push: 'false', load: 'true', tags: `${IMAGE}:pr-12`, refs: `${IMAGE}:pr-12`, image: `${IMAGE}:pr-12`, outputs: '',
      provenance: 'false', sbom: 'false', 'build-args': 'DEPLOYMENT_REVISION=abc', labels: REVISION_LABELS.join('\n'),
    },
  },
  {
    name: 'release-image digest push',
    env: { TAGS: '', PUSH: 'false', PUSH_BY_DIGEST: 'true', LOAD: 'false', VERSION: '1.2.3', PROVENANCE: 'max' },
    expected: {
      push: 'false', load: 'false', tags: '', outputs: DIGEST_OUTPUTS, provenance: 'mode=max', sbom: 'false',
      'build-args': 'DEPLOYMENT_REVISION=abc\nAPP_VERSION=1.2.3',
      labels: [...REVISION_LABELS, 'org.opencontainers.image.version=1.2.3'].join('\n'),
    },
  },
  {
    name: 'release-image dry run',
    env: { TAGS: 'sha-abc', PUSH: 'false', PUSH_BY_DIGEST: 'false', LOAD: 'true', VERSION: '1.2.3', PROVENANCE: 'min' },
    expected: {
      push: 'false', load: 'true', tags: `${IMAGE}:sha-abc`, refs: `${IMAGE}:sha-abc`, image: `${IMAGE}:sha-abc`, outputs: '',
      provenance: 'false', sbom: 'false', 'build-args': 'DEPLOYMENT_REVISION=abc\nAPP_VERSION=1.2.3',
      labels: [...REVISION_LABELS, 'org.opencontainers.image.version=1.2.3'].join('\n'),
    },
  },
]

for (const { name, env, expected } of callers) {
  test(`accepts the ${name} inputs`, () => {
    const result = prepare(env)
    assert.equal(result.status, 0, result.log)
    assert.equal(result.outputs.name, IMAGE)
    for (const [key, value] of Object.entries(expected)) assert.equal(result.outputs[key], value, key)
    if (env.PUSH_BY_DIGEST === 'true') {
      assert.equal(result.outputs.image, undefined, 'digest pushes resolve the image after the build')
      assert.equal(result.outputs.refs, undefined)
    }
  })
}

test('digest push rejects tags and load, but accepts whitespace-only tags', () => {
  const tagged = prepare({ PUSH_BY_DIGEST: 'true', TAGS: 'pr-1' })
  assert.equal(tagged.status, 1)
  assert.match(tagged.log, /::error::push-by-digest creates no tags/u)

  const loaded = prepare({ PUSH_BY_DIGEST: 'true', LOAD: 'true' })
  assert.equal(loaded.status, 1)
  assert.match(loaded.log, /::error::push-by-digest cannot load/u)

  const blank = prepare({ PUSH_BY_DIGEST: 'true', TAGS: ' \n\t\n', LOAD: 'false' })
  assert.equal(blank.status, 0, blank.log)
  assert.equal(blank.outputs.tags, '')
  assert.equal(blank.outputs.outputs, DIGEST_OUTPUTS)
})

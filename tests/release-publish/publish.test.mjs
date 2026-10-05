import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GitHubError } from '../../.github/actions/_lib/github.mjs'
import { checkGate, ensureRelease, makeLatest, planPush, remoteTagCommit } from '../../.github/actions/release-publish/publish.mjs'

test('gate allows only the release branch, unless dry-run', () => {
  assert.equal(checkGate({ ref: 'refs/heads/main', branch: 'main', dryRun: false }).ok, true)
  assert.equal(checkGate({ ref: 'refs/heads/feature', branch: 'main', dryRun: false }).ok, false)
  assert.equal(checkGate({ ref: 'refs/tags/v1.0.0', branch: 'main', dryRun: false }).ok, false)
  assert.match(checkGate({ ref: 'refs/heads/feature', branch: 'main', dryRun: true }).message, /ignored in dry-run/)
})

test('remote tag commit prefers the peeled annotated entry', () => {
  assert.equal(remoteTagCommit('', 'v1.0.0'), null)
  assert.equal(remoteTagCommit('aaa\trefs/tags/v1.0.0\n', 'v1.0.0'), 'aaa')
  assert.equal(remoteTagCommit('ttt\trefs/tags/v1.0.0\nccc\trefs/tags/v1.0.0^{}\n', 'v1.0.0'), 'ccc')
})

test('push plan skips only a resumed tag at the same commit', () => {
  assert.equal(planPush({ remoteCommit: null, sha: 'a', tag: 'v1', resumed: false }), 'push')
  assert.equal(planPush({ remoteCommit: null, sha: 'a', tag: 'v1', resumed: true }), 'push')
  assert.equal(planPush({ remoteCommit: 'a', sha: 'a', tag: 'v1', resumed: true }), 'skip')
  assert.throws(() => planPush({ remoteCommit: 'a', sha: 'a', tag: 'v1', resumed: false }), /already exists/)
  assert.throws(() => planPush({ remoteCommit: 'b', sha: 'a', tag: 'v1', resumed: true }), /not a/)
})

test('make-latest auto marks only the highest stable version', () => {
  const tags = ['v1.0.0', 'v1.1.0', 'v2.0.0-rc.0']
  assert.equal(makeLatest('auto', 'v1.1.0', tags, false), 'true')
  assert.equal(makeLatest('auto', 'v1.0.1', [...tags, 'v1.0.1'], false), 'false')
  assert.equal(makeLatest('auto', 'v2.0.0-rc.0', tags, true), 'false')
  assert.equal(makeLatest('auto', 'v3.0.0', [], false), 'true')
  assert.equal(makeLatest('true', 'v1.0.1', tags, false), 'true')
  assert.throws(() => makeLatest('legacy', 'v1.0.0', tags, false), /make-latest/)
})

function fakeClient(create) {
  let stored = null
  const calls = []
  return {
    calls,
    setStored: release => { stored = release },
    request: async (method, path, options = {}) => {
      calls.push(`${method} ${path}`)
      if (method === 'GET') return stored
      return create(options.body, release => { stored = release })
    },
  }
}
const input = { tag: 'v1.0.0', sha: 'a', prerelease: false, makeLatest: 'true' }

test('ensureRelease creates, reuses, and survives a concurrent create', async () => {
  const fresh = fakeClient(body => ({ id: 1, html_url: 'u', body }))
  const created = await ensureRelease(fresh, 'o/r', input, () => {})
  assert.equal(created.id, 1)
  assert.deepEqual(created.body, {
    tag_name: 'v1.0.0', name: 'v1.0.0', target_commitish: 'a', generate_release_notes: true, prerelease: false, make_latest: 'true',
  })

  const existing = fakeClient(() => assert.fail('must not create'))
  existing.setStored({ id: 2 })
  assert.equal((await ensureRelease(existing, 'o/r', input, () => {})).id, 2)

  const raced = fakeClient((body, store) => {
    store({ id: 3 })
    throw new GitHubError(422, 'GitHub POST /repos/o/r/releases failed with HTTP 422: {"errors":[{"code":"already_exists"}]}')
  })
  assert.equal((await ensureRelease(raced, 'o/r', input, () => {})).id, 3)
  assert.deepEqual(raced.calls, ['GET /repos/o/r/releases/tags/v1.0.0', 'POST /repos/o/r/releases', 'GET /repos/o/r/releases/tags/v1.0.0'])

  const invalid = fakeClient(() => { throw new GitHubError(422, 'HTTP 422: {"errors":[{"code":"invalid"}]}') })
  await assert.rejects(ensureRelease(invalid, 'o/r', input, () => {}), GitHubError)
})

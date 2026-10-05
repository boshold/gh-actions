import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findGreenRun } from '../../.github/actions/ci-status/status.mjs'

const sha = 'a'.repeat(40)

test('finds a completed successful run on the sha, never the current run', () => {
  const runs = [
    { id: 9, head_sha: sha, status: 'completed', conclusion: 'success' },
    { id: 8, head_sha: sha, status: 'completed', conclusion: 'failure' },
    { id: 7, head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'success' },
    { id: 6, head_sha: sha, status: 'completed', conclusion: 'success' },
  ]
  assert.equal(findGreenRun(runs, { sha, currentRunId: '1' }).id, 9)
  assert.equal(findGreenRun(runs, { sha, currentRunId: '9' }).id, 6)
  assert.equal(findGreenRun(runs.slice(1, 3), { sha }), null)
})

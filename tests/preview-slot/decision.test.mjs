import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkOwner, decidePreview } from '../../.github/actions/preview-slot/decision.mjs'

const repository = 'owner/example'
const owner = (number, labels = ['preview'], headRepository = repository) => ({ number, labels, headRepository })
const event = (action, overrides = {}) => ({
  repository, label: 'preview', eventName: 'pull_request', action, eventLabel: 'preview', prNumber: 2,
  headRepository: repository, hadLabel: true, ...overrides,
})
const noRemove = async () => assert.fail('must not remove a label')

test('new preview owner removes the prior label and deploys only its PR', async () => {
  let open = [owner(1), owner(2)]
  const removed = []
  const result = await decidePreview(event('labeled'), async () => open, async (number) => {
    removed.push(number)
    open = open.map(pullRequest => pullRequest.number === number ? owner(number, []) : pullRequest)
  })
  assert.deepEqual(removed, [1])
  assert.deepEqual(result, { deploy: true, placeholder: false })
})

test('a stale list after removal still deploys the new owner', async () => {
  const result = await decidePreview(event('labeled'), async () => [owner(1), owner(2)], async () => {})
  assert.deepEqual(result, { deploy: true, placeholder: false })
})

test('a concurrent claim that removed our label stops the deploy', async () => {
  let calls = 0
  const list = async () => (++calls === 1 ? [owner(1), owner(2)] : [owner(2, []), owner(3)])
  const result = await decidePreview(event('labeled'), list, async () => {})
  assert.deepEqual(result, { deploy: false, placeholder: false })
})

test('unrelated label and fork events do not replace the slot', async () => {
  const list = async () => [owner(2)]
  assert.deepEqual(await decidePreview(event('labeled', { eventLabel: 'review' }), list, noRemove), { deploy: false, placeholder: false })
  assert.deepEqual(await decidePreview(event('labeled', { headRepository: 'fork/example' }), async () => [owner(1), owner(2, ['preview'], 'fork/example')], noRemove), {
    deploy: false, placeholder: false,
  })
  assert.deepEqual(await decidePreview(event('synchronize', { headRepository: 'fork/example' }), async () => [owner(2, ['preview'], 'fork/example')], noRemove), {
    deploy: false, placeholder: false,
  })
  assert.deepEqual(await decidePreview(event('closed', { hadLabel: false }), list, noRemove), { deploy: false, placeholder: false })
})

test('a released slot restores the placeholder only when no owner remains', async () => {
  assert.deepEqual(await decidePreview(event('unlabeled'), async () => [], noRemove), { deploy: false, placeholder: true })
  assert.deepEqual(await decidePreview(event('unlabeled'), async () => [owner(3)], noRemove), { deploy: false, placeholder: false })
  assert.deepEqual(await decidePreview(event('closed'), async () => [], noRemove), { deploy: false, placeholder: true })
  assert.deepEqual(await decidePreview(event('', { eventName: 'workflow_dispatch' }), async () => [], noRemove), { deploy: false, placeholder: true })
  assert.deepEqual(await decidePreview(event('', { eventName: 'workflow_dispatch' }), async () => [owner(4, ['preview'], 'fork/x')], noRemove), {
    deploy: false, placeholder: true,
  })
})

const sha = 'a'.repeat(40)
const pull = (overrides = {}) => ({ number: 2, state: 'open', labels: ['preview'], headRepository: repository, headSha: sha, ...overrides })
const check = (pullRequest, open, mode = 'check') =>
  checkOwner({ mode, label: 'preview', repository, prNumber: 2, headSha: sha }, pullRequest, open).owner

test('check passes only for the single current same-repo owner at the built sha', () => {
  assert.equal(check(pull(), [owner(2), owner(5, ['other'])]), true)
  assert.equal(check(pull(), [owner(2), owner(3, ['preview'], 'fork/x')]), true)
  assert.equal(check(null, [owner(2)]), false)
  assert.equal(check(pull({ state: 'closed' }), []), false)
  assert.equal(check(pull({ headRepository: 'fork/example' }), [owner(2, ['preview'], 'fork/example')]), false)
  assert.equal(check(pull({ labels: [] }), [owner(3)]), false)
  assert.equal(check(pull(), [owner(2), owner(3)]), false)
  assert.equal(check(pull(), [owner(3)]), false)
  assert.equal(check(pull({ headSha: 'b'.repeat(40) }), [owner(2)]), false)
})

test('check-idle passes only when no open same-repo PR has the label', () => {
  assert.equal(check(null, [], 'check-idle'), true)
  assert.equal(check(null, [owner(4, ['preview'], 'fork/x'), owner(5, ['other'])], 'check-idle'), true)
  assert.equal(check(null, [owner(4)], 'check-idle'), false)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decidePreview } from '../../.github/actions/preview-slot/decision.mjs'

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

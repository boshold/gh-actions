import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient, GitHubError } from '../../.github/actions/_lib/github.mjs'

const json = (value, init = {}) => new Response(JSON.stringify(value), { status: 200, ...init })

test('retries 5xx and network errors with backoff, then succeeds', async () => {
  const replies = [new Error('ECONNRESET'), new Response('', { status: 502 }), json({ ok: 1 })]
  const calls = []
  const pauses = []
  const client = createClient({
    token: 't', baseUrl: 'https://api.test', pause: async (ms) => { pauses.push(ms) },
    fetch: async (url, init) => {
      calls.push({ url, ...init })
      const reply = replies.shift()
      if (reply instanceof Error) throw reply
      return reply
    },
  })
  assert.deepEqual(await client.request('POST', '/repos/o/r/releases', { body: { tag_name: 'v1' } }), { ok: 1 })
  assert.equal(calls.length, 3)
  assert.deepEqual(pauses, [1000, 2000])
  for (const call of calls) {
    assert.equal(call.url, 'https://api.test/repos/o/r/releases')
    assert.equal(call.method, 'POST')
    assert.equal(call.body, '{"tag_name":"v1"}', 'the same JSON body on every attempt')
    assert.equal(call.headers['content-type'], 'application/json')
    assert.equal(call.headers.authorization, 'Bearer t')
    assert.ok(call.signal instanceof AbortSignal)
  }
})

test('binary bodies are sent raw with their own content type, absolute URLs as given', async () => {
  const calls = []
  const client = createClient({ token: 't', baseUrl: 'https://api.test', fetch: async (url, init) => { calls.push({ url, ...init }); return json({ id: 1 }) } })
  const bytes = Buffer.from([0, 255])
  await client.request('POST', 'https://uploads.test/assets?name=a', { body: bytes, headers: { 'content-type': 'application/octet-stream' } })
  assert.equal(calls[0].url, 'https://uploads.test/assets?name=a')
  assert.equal(calls[0].body, bytes)
  assert.equal(calls[0].headers['content-type'], 'application/octet-stream')
})

test('404 is null only when allowed, 4xx errors carry the status and are not retried', async () => {
  let calls = 0
  const client = createClient({ token: 't', baseUrl: 'https://api.test', pause: async () => assert.fail('no retry'), fetch: async () => { calls += 1; return new Response('nope', { status: 404 }) } })
  assert.equal(await client.request('DELETE', '/x', { allow404: true }), null)
  await assert.rejects(client.request('GET', '/x'), error => error instanceof GitHubError && error.status === 404)
  for (const status of [401, 403, 422]) {
    const failing = createClient({ token: 't', baseUrl: 'https://api.test', pause: async () => assert.fail('no retry'), fetch: async () => { calls += 1; return new Response('bad', { status }) } })
    await assert.rejects(failing.request('PATCH', '/x'), error => error instanceof GitHubError && error.status === status && error.message === `GitHub PATCH /x failed with HTTP ${status}: bad`)
  }
  assert.equal(calls, 5)
})

test('paginate follows Link headers', async () => {
  const pages = {
    'https://api.test/items?page=1': json({ items: [1, 2] }, { headers: { link: '<https://api.test/items?page=2>; rel="next"' } }),
    'https://api.test/items?page=2': json({ items: [3] }),
  }
  const requested = []
  const client = createClient({
    token: 't', baseUrl: 'https://api.test',
    fetch: async (url, init) => {
      requested.push(`${init.method} ${url}`)
      assert.equal(init.body, undefined)
      return pages[url]
    },
  })
  assert.deepEqual(await client.paginate('/items?page=1', data => data.items), [1, 2, 3])
  assert.deepEqual(requested, ['GET https://api.test/items?page=1', 'GET https://api.test/items?page=2'])
})

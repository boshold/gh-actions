import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient, GitHubError } from '../../.github/actions/_lib/github.mjs'

const json = (value, init = {}) => new Response(JSON.stringify(value), { status: 200, ...init })

test('retries 5xx and network errors, then succeeds', async () => {
  const replies = [new Error('ECONNRESET'), new Response('', { status: 502 }), json({ ok: 1 })]
  const calls = []
  const client = createClient({
    token: 't', baseUrl: 'https://api.test', pause: async () => {},
    fetch: async (url, init) => {
      calls.push(init)
      const reply = replies.shift()
      if (reply instanceof Error) throw reply
      return reply
    },
  })
  assert.deepEqual(await client.request('GET', '/x'), { ok: 1 })
  assert.equal(calls.length, 3)
  assert.ok(calls[0].signal instanceof AbortSignal)
  assert.equal(calls[0].headers.authorization, 'Bearer t')
})

test('404 is null only when allowed, other errors carry the status', async () => {
  const client = createClient({ token: 't', baseUrl: 'https://api.test', fetch: async () => new Response('nope', { status: 404 }) })
  assert.equal(await client.request('DELETE', '/x', { allow404: true }), null)
  await assert.rejects(client.request('GET', '/x'), error => error instanceof GitHubError && error.status === 404)
})

test('paginate follows Link headers', async () => {
  const pages = {
    'https://api.test/items?page=1': json({ items: [1, 2] }, { headers: { link: '<https://api.test/items?page=2>; rel="next"' } }),
    'https://api.test/items?page=2': json({ items: [3] }),
  }
  const client = createClient({ token: 't', baseUrl: 'https://api.test', fetch: async url => pages[url] })
  assert.deepEqual(await client.paginate('/items?page=1', data => data.items), [1, 2, 3])
})

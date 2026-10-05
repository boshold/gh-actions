import { readFileSync } from 'node:fs'

export class GitHubError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'GitHubError'
    this.status = status
  }
}

const wait = ms => new Promise(resolve => { setTimeout(resolve, ms) })

export function createClient({
  token,
  baseUrl = process.env.GITHUB_API_URL || 'https://api.github.com',
  fetch = globalThis.fetch,
  pause = wait,
  timeoutMs = 30_000,
  attempts = 3,
} = {}) {
  if (!token) throw new Error('A GitHub token is required')

  // Retries network errors and 5xx. `allow404` returns null instead of throwing.
  async function request(method, path, { body, headers = {}, allow404 = false } = {}) {
    const url = /^https?:/.test(path) ? path : `${baseUrl}${path}`
    const binary = body instanceof Uint8Array
    for (let attempt = 1; ; attempt++) {
      let response
      try {
        response = await fetch(url, {
          method,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'x-github-api-version': '2022-11-28',
            ...(body === undefined || binary ? {} : { 'content-type': 'application/json' }),
            ...headers,
          },
          ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (cause) {
        if (attempt < attempts) { await pause(1000 * attempt); continue }
        throw new Error(`GitHub ${method} ${path} failed: ${cause instanceof Error ? cause.message : cause}`)
      }
      if (response.status >= 500 && attempt < attempts) { await pause(1000 * attempt); continue }
      if (response.status === 404 && allow404) return null
      const text = await response.text()
      if (!response.ok) {
        throw new GitHubError(response.status, `GitHub ${method} ${path} failed with HTTP ${response.status}: ${text.slice(0, 300)}`)
      }
      const data = text === '' ? null : JSON.parse(text)
      return { data, link: response.headers.get('link') ?? '' }
    }
  }

  async function json(method, path, options) {
    const result = await request(method, path, options)
    return result === null ? null : result.data
  }

  // `pick` extracts the array from wrapped responses such as { workflow_runs: [...] }; `until` stops early.
  async function paginate(path, pick = data => data, until = () => false) {
    const items = []
    let next = path
    while (next) {
      const { data, link } = await request('GET', next)
      const page = pick(data)
      if (!Array.isArray(page)) throw new Error(`GitHub GET ${next} returned no list`)
      items.push(...page)
      if (page.some(until)) break
      next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1]
    }
    return items
  }

  return { request: json, paginate }
}

export function readEvent(path = process.env.GITHUB_EVENT_PATH) {
  if (!path) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

export function repository() {
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set')
  return repo
}

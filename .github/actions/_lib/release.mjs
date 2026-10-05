import { createHash } from 'node:crypto'
import { globSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

export function expandGlobs(patterns, cwd = '.') {
  const files = []
  for (const pattern of patterns) {
    const matches = globSync(pattern, { cwd }).map(file => resolve(cwd, file)).filter(file => statSync(file).isFile()).sort()
    if (matches.length === 0) throw new Error(`No file matches ${pattern}`)
    files.push(...matches)
  }
  const unique = [...new Set(files)]
  const names = unique.map(file => basename(file))
  const duplicate = names.find((name, index) => names.indexOf(name) !== index)
  if (duplicate) throw new Error(`Two assets share the name ${duplicate}`)
  return unique
}

export function checksums(files) {
  return files.map(file => `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${basename(file)}`).join('\n') + '\n'
}

export function writeChecksums(files, dir) {
  const path = join(dir, 'SHA256SUMS')
  writeFileSync(path, checksums(files))
  return path
}

// Drafts have no tag lookup, so fall back to the (newest-first) release list.
export async function releaseByTag(client, repo, tag) {
  const published = await client.request('GET', `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { allow404: true })
  if (published) return published
  const match = release => release.tag_name === tag
  return (await client.paginate(`/repos/${repo}/releases?per_page=100`, data => data, match)).find(match) ?? null
}

// clobber: replace an existing asset of the same name; otherwise keep it.
export async function uploadAssets(client, repo, release, files, { clobber = false, log = console.log } = {}) {
  const existing = await client.paginate(`/repos/${repo}/releases/${release.id}/assets?per_page=100`)
  const uploadUrl = release.upload_url.replace(/\{.*\}$/, '')
  const uploaded = []
  for (const file of files) {
    const name = basename(file)
    const old = existing.find(asset => asset.name === name)
    if (old && !clobber) {
      log(`Asset ${name} exists, kept`)
      continue
    }
    if (old) await client.request('DELETE', `/repos/${repo}/releases/assets/${old.id}`, { allow404: true })
    await client.request('POST', `${uploadUrl}?name=${encodeURIComponent(name)}`, {
      body: readFileSync(file),
      headers: { 'content-type': 'application/octet-stream' },
    })
    log(`Uploaded ${name}`)
    uploaded.push(name)
  }
  return uploaded
}

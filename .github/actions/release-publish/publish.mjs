import { GitHubError } from '../_lib/github.mjs'
import { releaseByTag } from '../_lib/release.mjs'
import { compare, latestTag, parse } from '../_lib/semver.mjs'

export function checkGate({ ref, branch, dryRun }) {
  if (ref === `refs/heads/${branch}`) return { ok: true, message: `Running on ${branch}` }
  const message = `Releases run only from ${branch}, not ${ref}`
  return dryRun ? { ok: true, message: `${message} (ignored in dry-run)` } : { ok: false, message }
}

// `git ls-remote` lines for the tag; the peeled `^{}` entry wins for annotated tags.
export function remoteTagCommit(lsRemote, tag) {
  const refs = Object.fromEntries(lsRemote.split('\n').filter(Boolean).map(line => line.split('\t').reverse()))
  return refs[`refs/tags/${tag}^{}`] ?? refs[`refs/tags/${tag}`] ?? null
}

export function planPush({ remoteCommit, sha, tag, resumed }) {
  if (remoteCommit === null) return 'push'
  if (remoteCommit !== sha) throw new Error(`${tag} already exists on the remote at ${remoteCommit}, not ${sha}`)
  if (!resumed) throw new Error(`${tag} already exists on the remote; rerun to resume or bump again`)
  return 'skip'
}

// auto: latest only for a stable version that is the highest stable tag.
export function makeLatest(mode, tag, tags, prerelease) {
  if (mode === 'true' || mode === 'false') return mode
  if (mode !== 'auto') throw new Error(`make-latest must be auto, true or false, got "${mode}"`)
  const version = parse(tag.replace(/^v/, ''))
  if (prerelease || !version || version.pre.length > 0) return 'false'
  const highest = latestTag(tags.filter(name => !name.includes('-')))
  return highest === null || compare(version, highest) >= 0 ? 'true' : 'false'
}

// Idempotent: reuses an existing release, including one created concurrently (422 already_exists).
export async function ensureRelease(client, repo, { tag, sha, prerelease, makeLatest: latest }, log = console.log) {
  const existing = await releaseByTag(client, repo, tag)
  if (existing) {
    log(`Release ${tag} exists`)
    return existing
  }
  try {
    const created = await client.request('POST', `/repos/${repo}/releases`, {
      body: { tag_name: tag, name: tag, target_commitish: sha, generate_release_notes: true, prerelease, make_latest: latest },
    })
    log(`Created release ${created.html_url}`)
    return created
  } catch (cause) {
    if (!(cause instanceof GitHubError && cause.status === 422 && cause.message.includes('already_exists'))) throw cause
    const raced = await releaseByTag(client, repo, tag)
    if (!raced) throw cause
    log(`Release ${tag} was created concurrently`)
    return raced
  }
}

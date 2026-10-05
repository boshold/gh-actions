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

export async function remoteTags(client, repo) {
  const refs = await client.paginate(`/repos/${repo}/git/matching-refs/tags/v?per_page=100`)
  return refs.map(ref => ref.ref.replace(/^refs\/tags\//, ''))
}

// Idempotent: reuses an existing release (drafts included), also one created concurrently (422 already_exists).
// make_latest is applied when publishing; a draft gets it on finalize.
export async function ensureRelease(client, repo, { tag, sha, prerelease, draft = false, makeLatest: latest }, log = console.log) {
  const existing = await releaseByTag(client, repo, tag)
  if (existing) {
    log(`Release ${tag} exists${existing.draft ? ' (draft)' : ''}`)
    return existing
  }
  try {
    const created = await client.request('POST', `/repos/${repo}/releases`, {
      body: {
        tag_name: tag, name: tag, target_commitish: sha, generate_release_notes: true, prerelease, draft,
        ...(draft ? {} : { make_latest: latest }),
      },
    })
    log(`Created ${draft ? 'draft ' : ''}release ${created.html_url}`)
    return created
  } catch (cause) {
    if (!(cause instanceof GitHubError && cause.status === 422 && cause.message.includes('already_exists'))) throw cause
    const raced = await releaseByTag(client, repo, tag)
    if (!raced) throw cause
    log(`Release ${tag} was created concurrently`)
    return raced
  }
}

// Publishes a draft release. An already published release is left as is.
export async function finalizeRelease(client, repo, { tag, makeLatest: mode }, log = console.log) {
  const release = await releaseByTag(client, repo, tag)
  if (!release) throw new Error(`No GitHub release for ${tag}`)
  if (!release.draft) {
    log(`Release ${tag} is already published`)
    return release
  }
  const latest = makeLatest(mode, tag, await remoteTags(client, repo), release.prerelease === true)
  const published = await client.request('PATCH', `/repos/${repo}/releases/${release.id}`, { body: { draft: false, make_latest: latest } })
  log(`Published release ${published.html_url}`)
  return published
}

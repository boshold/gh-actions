import { bool, input, lines, mask, notice, run, setOutput, summary } from '../_lib/core.mjs'
import { basicAuth, git, gitWithToken } from '../_lib/git.mjs'
import { createClient, readEvent, repository } from '../_lib/github.mjs'
import { expandGlobs, uploadAssets } from '../_lib/release.mjs'
import { checkGate, ensureRelease, finalizeRelease, makeLatest, planPush, remoteTagCommit, remoteTags } from './publish.mjs'

await run(async () => {
  const mode = input('mode') || 'publish'
  if (!['gate', 'publish', 'finalize'].includes(mode)) throw new Error(`mode must be gate, publish or finalize, got "${mode}"`)
  const dryRun = bool('dry-run')
  const token = input('token', { required: true })
  mask(token)
  const repo = repository()
  const client = createClient({ token })

  const event = readEvent()
  const branch = input('branch')
    || (event.repository?.full_name === repo ? event.repository.default_branch : '')
    || (await client.request('GET', `/repos/${repo}`)).default_branch
  const gate = checkGate({ ref: process.env.GITHUB_REF ?? '', branch, dryRun })
  if (!gate.ok) throw new Error(gate.message)
  console.log(gate.message)
  if (mode === 'gate') return

  const tag = input('tag', { required: true })
  if (mode === 'finalize') {
    if (dryRun) return notice(`Dry run: would publish the draft release ${tag}`)
    const release = await finalizeRelease(client, repo, { tag, makeLatest: input('make-latest') || 'auto' })
    setOutput('release-id', release.id)
    setOutput('url', release.html_url)
    return summary(`Released [${tag}](${release.html_url})`)
  }
  const sha = input('sha', { required: true })
  const prerelease = bool('prerelease')
  const draft = bool('draft')
  const workingDirectory = input('working-directory') || '.'
  process.chdir(workingDirectory)
  const assets = expandGlobs(lines(input('assets')))

  const remote = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}.git`
  mask(basicAuth(token))
  const authed = (...args) => gitWithToken(token, ...args)

  const action = planPush({
    remoteCommit: remoteTagCommit(authed('ls-remote', remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`), tag),
    sha,
    tag,
    resumed: bool('resumed'),
  })
  if (git('rev-parse', `${tag}^{commit}`) !== sha) throw new Error(`Local ${tag} does not point at ${sha}`)

  if (dryRun) {
    notice(`Dry run: would ${action === 'push' ? `push ${sha} to ${branch} with ${tag}` : 'skip the push'} and release ${tag}`)
    return
  }
  if (action === 'push') {
    authed('push', '--atomic', remote, `${sha}:refs/heads/${branch}`, `refs/tags/${tag}:refs/tags/${tag}`)
    console.log(`Pushed ${branch} and ${tag}`)
  } else {
    console.log(`${tag} is already on the remote; push skipped`)
  }

  const release = await ensureRelease(client, repo, {
    tag,
    sha,
    prerelease,
    draft,
    makeLatest: makeLatest(input('make-latest') || 'auto', tag, await remoteTags(client, repo), prerelease),
  })
  if (assets.length > 0) await uploadAssets(client, repo, release, assets, { clobber: false })

  setOutput('release-id', release.id)
  setOutput('url', release.html_url)
  summary(release.draft ? `Draft release [${tag}](${release.html_url}); run mode: finalize to publish` : `Released [${tag}](${release.html_url})`)
})

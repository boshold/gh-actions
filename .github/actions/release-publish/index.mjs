import { bool, input, lines, mask, notice, run, setOutput, summary } from '../_lib/core.mjs'
import { git } from '../_lib/git.mjs'
import { createClient, readEvent, repository } from '../_lib/github.mjs'
import { expandGlobs, uploadAssets } from '../_lib/release.mjs'
import { checkGate, ensureRelease, makeLatest, planPush, remoteTagCommit } from './publish.mjs'

await run(async () => {
  const mode = input('mode') || 'publish'
  if (!['gate', 'publish'].includes(mode)) throw new Error(`mode must be gate or publish, got "${mode}"`)
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
  const sha = input('sha', { required: true })
  const prerelease = bool('prerelease')
  const workingDirectory = input('working-directory') || '.'
  process.chdir(workingDirectory)
  const assets = expandGlobs(lines(input('assets')))

  const remote = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}.git`
  const auth = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
  mask(auth.split(' ').at(-1))
  // Reset inherited extraheaders so only this token is sent; nothing is persisted.
  const authed = (...args) => git('-c', 'http.extraheader=', '-c', `http.extraheader=${auth}`, ...args)

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
    makeLatest: makeLatest(input('make-latest') || 'auto', tag, lines(git('tag', '--list', 'v*')), prerelease),
  })
  if (assets.length > 0) await uploadAssets(client, repo, release, assets, { clobber: false })

  setOutput('release-id', release.id)
  setOutput('url', release.html_url)
  summary(`Released [${tag}](${release.html_url})`)
})

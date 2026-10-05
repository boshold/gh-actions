import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bool, input, lines, run, setOutput } from '../_lib/core.mjs'
import { createClient, repository } from '../_lib/github.mjs'
import { expandGlobs, releaseByTag, uploadAssets, writeChecksums } from '../_lib/release.mjs'

await run(async () => {
  const tag = input('tag', { required: true })
  const files = expandGlobs(lines(input('files', { required: true })), input('working-directory') || '.')
  if (bool('checksums', true)) {
    if (files.some(file => file.endsWith('/SHA256SUMS'))) throw new Error('SHA256SUMS is generated; do not pass it in files')
    files.push(writeChecksums(files, mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'release-assets-'))))
  }
  const repo = repository()
  const client = createClient({ token: input('token', { required: true }) })
  const release = await releaseByTag(client, repo, tag)
  if (!release) throw new Error(`No GitHub release for ${tag}`)
  const uploaded = await uploadAssets(client, repo, release, files, { clobber: bool('clobber', true) })
  setOutput('uploaded', uploaded)
})

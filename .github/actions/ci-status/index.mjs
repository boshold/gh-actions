import { input, run, setOutput } from '../_lib/core.mjs'
import { createClient, repository } from '../_lib/github.mjs'
import { findGreenRun } from './status.mjs'

await run(async () => {
  const workflow = input('workflow', { required: true })
  const sha = input('sha') || process.env.GITHUB_SHA
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error(`sha must be a full commit sha, got "${sha}"`)
  const client = createClient({ token: input('token', { required: true }) })
  const path = `/repos/${repository()}/actions/workflows/${encodeURIComponent(workflow)}/runs?head_sha=${sha}&status=success&per_page=20`
  const { workflow_runs: runs = [] } = await client.request('GET', path)
  const green = findGreenRun(runs, { sha, currentRunId: process.env.GITHUB_RUN_ID })
  console.log(green ? `${workflow} passed on ${sha}: ${green.html_url}` : `No successful ${workflow} run on ${sha}`)
  setOutput('passed', green !== null)
  setOutput('run-id', green?.id ?? '')
})

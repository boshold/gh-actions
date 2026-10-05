import { input, run, setOutput } from '../_lib/core.mjs'
import { createClient, readEvent, repository } from '../_lib/github.mjs'
import { decidePreview } from './decision.mjs'

await run(async () => {
  const repo = repository()
  const label = input('label') || 'preview'
  const client = createClient({ token: input('token', { required: true }) })
  const payload = readEvent()
  const pullRequest = payload.pull_request

  async function listOpenPullRequests() {
    const pulls = await client.paginate(`/repos/${repo}/pulls?state=open&per_page=100`)
    return pulls.map((pull) => {
      if (!Number.isInteger(pull.number) || !Array.isArray(pull.labels)) throw new Error('GitHub returned an invalid pull request')
      return { number: pull.number, labels: pull.labels.map(item => item.name), headRepository: pull.head?.repo?.full_name }
    })
  }

  const result = await decidePreview({
    repository: repo,
    label,
    eventName: process.env.GITHUB_EVENT_NAME,
    action: payload.action,
    eventLabel: payload.label?.name,
    prNumber: pullRequest?.number,
    headRepository: pullRequest?.head?.repo?.full_name,
    hadLabel: (pullRequest?.labels ?? []).some(item => item.name === label),
  }, listOpenPullRequests, (number, name) =>
    client.request('DELETE', `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`, { allow404: true }))

  console.log(`deploy=${result.deploy} placeholder=${result.placeholder}`)
  setOutput('deploy', result.deploy)
  setOutput('placeholder', result.placeholder)
})

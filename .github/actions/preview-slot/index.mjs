import { info, input, run, setOutput } from '../_lib/core.mjs'
import { createClient, readEvent, repository } from '../_lib/github.mjs'
import { checkOwner, decidePreview } from './decision.mjs'

const modes = ['decide', 'check', 'check-idle']

function toPullRequest(pull) {
  if (!Number.isInteger(pull?.number) || !Array.isArray(pull.labels)) throw new Error('GitHub returned an invalid pull request')
  return {
    number: pull.number,
    state: pull.state,
    labels: pull.labels.map(item => item.name),
    headRepository: pull.head?.repo?.full_name,
    headSha: pull.head?.sha,
  }
}

await run(async () => {
  const repo = repository()
  const label = input('label') || 'preview'
  const mode = input('mode') || 'decide'
  if (!modes.includes(mode)) throw new Error(`Input mode must be one of ${modes.join(', ')}, got "${mode}"`)
  const client = createClient({ token: input('token', { required: true }) })

  async function listOpenPullRequests() {
    return (await client.paginate(`/repos/${repo}/pulls?state=open&per_page=100`)).map(toPullRequest)
  }

  if (mode !== 'decide') {
    let prNumber = 0
    let headSha = ''
    if (mode === 'check') {
      const pr = input('pr', { required: true })
      if (!/^[1-9][0-9]*$/.test(pr)) throw new Error(`Input pr must be a pull request number, got "${pr}"`)
      prNumber = Number(pr)
      headSha = input('head-sha', { required: true }).toLowerCase()
      if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(headSha)) throw new Error(`Input head-sha must be a full commit sha, got "${headSha}"`)
    }
    const pull = mode === 'check' ? await client.request('GET', `/repos/${repo}/pulls/${prNumber}`, { allow404: true }) : null
    const result = checkOwner(
      { mode, label, repository: repo, prNumber, headSha },
      pull === null ? null : toPullRequest(pull),
      await listOpenPullRequests(),
    )
    info(`owner=${result.owner}: ${result.reason}`)
    setOutput('owner', result.owner)
    return
  }

  const payload = readEvent()
  const pullRequest = payload.pull_request
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

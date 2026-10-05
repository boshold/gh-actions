// listOpenPullRequests: () => [{ number, labels: string[], headRepository }]
// removeLabel must tolerate a label that is already gone.
export async function decidePreview(event, listOpenPullRequests, removeLabel) {
  const owns = pullRequest => pullRequest.labels.includes(event.label)
  const sameRepository = pullRequest => pullRequest.headRepository === event.repository
  const open = await listOpenPullRequests()

  if (event.eventName === 'workflow_dispatch') {
    return { deploy: false, placeholder: !open.some(pullRequest => owns(pullRequest) && sameRepository(pullRequest)) }
  }

  const isSameRepository = event.headRepository === event.repository
  const claimed = event.action === 'labeled' && event.eventLabel === event.label
  let current = open
  if (claimed && isSameRepository) {
    const removed = []
    for (const pullRequest of open.filter(pullRequest => owns(pullRequest) && pullRequest.number !== event.prNumber)) {
      await removeLabel(pullRequest.number, event.label)
      removed.push(pullRequest.number)
    }
    // Re-read so a concurrent claim that removed our label is seen; ignore stale reads of our removals.
    if (removed.length > 0) current = (await listOpenPullRequests()).filter(pullRequest => !removed.includes(pullRequest.number))
  }

  const owners = current.filter(pullRequest => owns(pullRequest) && sameRepository(pullRequest))
  const released = (event.action === 'unlabeled' && event.eventLabel === event.label)
    || (event.action === 'closed' && event.hadLabel)
  if (released) return { deploy: false, placeholder: owners.length === 0 }

  const deployEvent = claimed || event.action === 'synchronize' || event.action === 'reopened'
  return {
    deploy: isSameRepository && deployEvent && owners.length === 1 && owners[0].number === event.prNumber,
    placeholder: false,
  }
}

// Revalidates the slot right before a deploy. pullRequest: { number, state, labels, headRepository, headSha } | null
export function checkOwner({ mode, label, repository, prNumber, headSha }, pullRequest, open) {
  const owners = open.filter(item => item.labels.includes(label) && item.headRepository === repository)
  if (mode === 'check-idle') {
    return owners.length === 0
      ? { owner: true, reason: 'no open pull request owns the slot' }
      : { owner: false, reason: `#${owners[0].number} owns the slot` }
  }
  if (!pullRequest || pullRequest.state !== 'open') return { owner: false, reason: `#${prNumber} is not open` }
  if (pullRequest.headRepository !== repository) return { owner: false, reason: `#${prNumber} is from a fork` }
  if (!pullRequest.labels.includes(label)) return { owner: false, reason: `#${prNumber} does not have label ${label}` }
  if (owners.length !== 1 || owners[0].number !== prNumber) {
    return { owner: false, reason: `slot owners are ${owners.map(item => `#${item.number}`).join(', ') || 'none'}, not only #${prNumber}` }
  }
  if (pullRequest.headSha !== headSha) return { owner: false, reason: `#${prNumber} head moved to ${pullRequest.headSha}` }
  return { owner: true, reason: `#${prNumber} owns the slot at ${headSha}` }
}

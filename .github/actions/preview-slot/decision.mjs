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

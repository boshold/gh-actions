export function findGreenRun(runs, { sha, currentRunId }) {
  return runs.find(run => run.head_sha === sha && run.status === 'completed' && run.conclusion === 'success'
    && String(run.id) !== String(currentRunId)) ?? null
}

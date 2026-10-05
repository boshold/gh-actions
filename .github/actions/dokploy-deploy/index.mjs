import { error, input, mask, setOutput } from '../_lib/core.mjs'
import { configFromInputs, DeployError, DokployDeployment, redact } from './deploy.mjs'

mask(input('api-key'))
let deployment
try {
  const mode = input('mode') || 'deploy'
  if (!['deploy', 'placeholder', 'stop'].includes(mode)) throw new DeployError('INPUT_INVALID', `Unknown mode: ${mode}`)
  deployment = new DokployDeployment(configFromInputs(name => input(name)))
  if (mode === 'stop') await deployment.stop()
  else if (mode === 'placeholder') await deployment.placeholder()
  else await deployment.deploy()
} catch (cause) {
  error(`${cause instanceof DeployError ? cause.code : 'DEPLOY_FAILED'}: ${redact(cause)}`)
  process.exitCode = 1
} finally {
  setOutput('previous-image', deployment?.previousImage ?? '')
  setOutput('rolled-back', deployment?.rolledBack ?? false)
}

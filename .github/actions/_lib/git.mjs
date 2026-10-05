import { execFileSync } from 'node:child_process'

export function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function gitTry(...args) {
  try {
    return git(...args)
  } catch {
    return null
  }
}

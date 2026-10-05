import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'

const escape = value => String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')

export function input(name, { required = false } = {}) {
  const value = (process.env[`INPUT_${name.replaceAll(' ', '_').toUpperCase()}`] ?? '').trim()
  if (required && value === '') throw new Error(`Input required and not supplied: ${name}`)
  return value
}

export function bool(name, fallback = false) {
  const value = input(name).toLowerCase()
  if (value === '') return fallback
  if (value === 'true' || value === 'false') return value === 'true'
  throw new Error(`Input ${name} must be true or false, got "${value}"`)
}

export function lines(text) {
  return text.split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'))
}

export function setOutput(name, value) {
  const text = typeof value === 'string' ? value : (typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? ''))
  if (!process.env.GITHUB_OUTPUT) return console.log(`${name}=${text}`)
  const delimiter = `EOF_${randomUUID()}`
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${text}\n${delimiter}\n`)
}

export function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
}

export function mask(value) {
  if (value) console.log(`::add-mask::${escape(value)}`)
}

export const info = message => console.log(message)
export const notice = message => console.log(`::notice::${escape(message)}`)
export const warning = message => console.log(`::warning::${escape(message)}`)
export const error = message => console.log(`::error::${escape(message)}`)

export function fail(cause) {
  error(cause instanceof Error ? cause.message : String(cause))
  process.exitCode = 1
}

export async function run(main) {
  try {
    await main()
  } catch (cause) {
    fail(cause)
  }
}

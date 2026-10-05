import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compare, format, inc, latestTag, parse } from '../../.github/actions/_lib/semver.mjs'

const bump = (version, kind, preid) => format(inc(parse(version), kind, preid))

test('parse rejects non-semver', () => {
  assert.equal(parse('1.2'), null)
  assert.equal(parse('01.2.3'), null)
  assert.equal(parse('1.2.3-'), null)
  assert.deepEqual(parse('1.2.3-rc.1'), { major: 1, minor: 2, patch: 3, pre: ['rc', 1] })
})

test('compare follows semver precedence', () => {
  const sorted = ['1.0.0', '1.0.0-rc.1', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta.11', '1.0.0-beta.2', '0.9.9', '1.0.0-alpha.beta']
    .map(parse).sort(compare).map(format)
  assert.deepEqual(sorted, ['0.9.9', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'])
})

test('latest tag ignores non-version tags and includes prereleases', () => {
  assert.equal(format(latestTag(['v0.9.0', 'v0.10.1', 'v0.10.0', 'nightly', 'v1.0.0-rc.1'])), '1.0.0-rc.1')
  assert.equal(format(latestTag(['v1.0.0-rc.1', 'v1.0.0'])), '1.0.0')
  assert.equal(latestTag(['x', '1.0.0']), null)
})

test('inc matches npm semver', () => {
  assert.equal(bump('1.2.3', 'patch'), '1.2.4')
  assert.equal(bump('1.2.3', 'minor'), '1.3.0')
  assert.equal(bump('1.2.3', 'major'), '2.0.0')
  assert.equal(bump('1.2.0-rc.1', 'patch'), '1.2.0')
  assert.equal(bump('1.2.0-rc.1', 'minor'), '1.2.0')
  assert.equal(bump('1.2.1-rc.1', 'minor'), '1.3.0')
  assert.equal(bump('2.0.0-rc.1', 'major'), '2.0.0')
  assert.equal(bump('2.1.0-rc.1', 'major'), '3.0.0')
  assert.equal(bump('1.2.3', 'prerelease'), '1.2.4-rc.0')
  assert.equal(bump('1.2.4-rc.0', 'prerelease'), '1.2.4-rc.1')
  assert.equal(bump('1.2.4-alpha.3', 'prerelease', 'beta'), '1.2.4-beta.0')
  assert.equal(bump('1.2.3', 'prepatch'), '1.2.4-rc.0')
  assert.equal(bump('1.2.3', 'preminor', 'beta'), '1.3.0-beta.0')
  assert.equal(bump('1.2.3', 'premajor'), '2.0.0-rc.0')
})

test('inc refuses invalid input and non-increasing results', () => {
  assert.throws(() => bump('1.2.3', 'huge'), /bump must be one of/)
  assert.throws(() => bump('1.2.3', 'prerelease', '1'), /preid/)
  assert.throws(() => bump('1.2.3', 'prerelease', 'a.b'), /preid/)
  assert.throws(() => bump('1.2.4-rc.1', 'prerelease', 'beta'), /not higher/)
})

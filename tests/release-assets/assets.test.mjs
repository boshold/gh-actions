import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checksums, expandGlobs, uploadAssets } from '../../.github/actions/_lib/release.mjs'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'release-assets-'))
  mkdirSync(join(dir, 'dist/sub'), { recursive: true })
  writeFileSync(join(dir, 'dist/a.tar.gz'), 'a')
  writeFileSync(join(dir, 'dist/b.zip'), 'b')
  writeFileSync(join(dir, 'dist/sub/a.tar.gz'), 'other')
  return dir
}

test('globs expand to unique files and fail when empty or ambiguous', () => {
  const dir = fixture()
  assert.deepEqual(expandGlobs(['dist/*'], dir), [join(dir, 'dist/a.tar.gz'), join(dir, 'dist/b.zip')])
  assert.throws(() => expandGlobs(['dist/*.exe'], dir), /No file matches/)
  assert.throws(() => expandGlobs(['dist/**/*.tar.gz'], dir), /share the name a\.tar\.gz/)
})

test('checksums use the sha256sum format', () => {
  const dir = fixture()
  assert.equal(
    checksums([join(dir, 'dist/a.tar.gz')]),
    'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  a.tar.gz\n',
  )
})

test('upload keeps or replaces existing assets', async () => {
  const dir = fixture()
  const calls = []
  const client = {
    paginate: async () => [{ id: 5, name: 'a.tar.gz' }],
    request: async (method, path) => { calls.push(`${method} ${path}`) },
  }
  const release = { id: 1, upload_url: 'https://uploads.test/repos/o/r/releases/1/assets{?name,label}' }
  const files = [join(dir, 'dist/a.tar.gz'), join(dir, 'dist/b.zip')]

  assert.deepEqual(await uploadAssets(client, 'o/r', release, files, { log: () => {} }), ['b.zip'])
  assert.deepEqual(calls, ['POST https://uploads.test/repos/o/r/releases/1/assets?name=b.zip'])

  calls.length = 0
  assert.deepEqual(await uploadAssets(client, 'o/r', release, files, { clobber: true, log: () => {} }), ['a.tar.gz', 'b.zip'])
  assert.deepEqual(calls, [
    'DELETE /repos/o/r/releases/assets/5',
    'POST https://uploads.test/repos/o/r/releases/1/assets?name=a.tar.gz',
    'POST https://uploads.test/repos/o/r/releases/1/assets?name=b.zip',
  ])
})

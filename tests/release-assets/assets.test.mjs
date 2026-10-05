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
  writeFileSync(join(dir, 'dist/c d+e.bin'), Buffer.from([0, 255, 10]))
  const calls = []
  const uploads = []
  const client = {
    paginate: async (path) => {
      assert.equal(path, '/repos/o/r/releases/1/assets?per_page=100')
      return [{ id: 5, name: 'a.tar.gz' }]
    },
    request: async (method, path, options) => {
      calls.push(`${method} ${path}`)
      if (method === 'DELETE') {
        assert.deepEqual(options, { allow404: true })
        return null
      }
      assert.equal(method, 'POST')
      assert.deepEqual(Object.keys(options).sort(), ['body', 'headers'])
      assert.ok(options.body instanceof Uint8Array, 'raw bytes, not JSON')
      assert.deepEqual(options.headers, { 'content-type': 'application/octet-stream' })
      uploads.push([decodeURIComponent(new URL(path).searchParams.get('name')), [...options.body]])
      return { id: 9 }
    },
  }
  const release = { id: 1, upload_url: 'https://uploads.test/repos/o/r/releases/1/assets{?name,label}' }
  const files = [join(dir, 'dist/a.tar.gz'), join(dir, 'dist/b.zip'), join(dir, 'dist/c d+e.bin')]
  const bytes = text => [...Buffer.from(text)]

  assert.deepEqual(await uploadAssets(client, 'o/r', release, files, { log: () => {} }), ['b.zip', 'c d+e.bin'])
  assert.deepEqual(calls, [
    'POST https://uploads.test/repos/o/r/releases/1/assets?name=b.zip',
    'POST https://uploads.test/repos/o/r/releases/1/assets?name=c%20d%2Be.bin',
  ])
  assert.deepEqual(uploads, [['b.zip', bytes('b')], ['c d+e.bin', [0, 255, 10]]])

  calls.length = 0
  uploads.length = 0
  assert.deepEqual(await uploadAssets(client, 'o/r', release, files.slice(0, 2), { clobber: true, log: () => {} }), ['a.tar.gz', 'b.zip'])
  assert.deepEqual(calls, [
    'DELETE /repos/o/r/releases/assets/5',
    'POST https://uploads.test/repos/o/r/releases/1/assets?name=a.tar.gz',
    'POST https://uploads.test/repos/o/r/releases/1/assets?name=b.zip',
  ])
  assert.deepEqual(uploads, [['a.tar.gz', bytes('a')], ['b.zip', bytes('b')]])

  const failing = { ...client, request: async (method) => { if (method === 'POST') throw new Error('HTTP 422') } }
  await assert.rejects(uploadAssets(failing, 'o/r', release, files.slice(1, 2), { log: () => {} }), /HTTP 422/)
})

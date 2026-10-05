import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  cargoInheritsVersion, cargoMemberDirs, cargoVersion, setCargoPathDependencyVersions, cargoPackageName, cargoWorkspace, planRelease, setCargoLockVersions, setCargoVersion,
  setJsonVersion, setTextVersion, workspaceManifests, workspacePatterns,
} from '../../.github/actions/release-version/version.mjs'

const runner = fileURLToPath(new URL('../../.github/actions/release-version/index.mjs', import.meta.url))

test('plan bumps the latest tag, or starts from 0.0.0', () => {
  const at = { head: 'a', parent: 'z', expected: 'a', headTags: [] }
  assert.deepEqual(planRelease({ ...at, tags: ['v0.5.1'], bump: 'minor' }), { version: '0.6.0', resumed: false })
  assert.deepEqual(planRelease({ ...at, tags: [], bump: 'minor' }), { version: '0.1.0', resumed: false })
  assert.deepEqual(planRelease({ ...at, tags: ['v1.0.0', 'v1.1.0-rc.0'], bump: 'prerelease' }), { version: '1.1.0-rc.1', resumed: false })
  assert.deepEqual(planRelease({ ...at, tags: ['v1.1.0-rc.1'], bump: 'patch' }), { version: '1.1.0', resumed: false })
  assert.throws(() => planRelease({ ...at, tags: [], bump: 'huge' }), /bump must be one of/)
})

test('plan resumes a tagged release commit instead of bumping again', () => {
  const tags = ['v0.5.1', 'v0.6.0']
  const releaseCommit = { tags, headTags: ['v0.6.0'], bump: 'minor', head: 'b', parent: 'a', expected: 'a' }
  assert.deepEqual(planRelease(releaseCommit), { version: '0.6.0', resumed: true })
  // Release without file changes: the tag sits on the tested commit and matches the bump.
  assert.deepEqual(planRelease({ ...releaseCommit, expected: 'b' }), { version: '0.6.0', resumed: true })
  assert.deepEqual(planRelease({ ...releaseCommit, tags: ['v1.0.0', 'v1.0.1-rc.0'], headTags: ['v1.0.1-rc.0'], bump: 'prerelease', parent: null, expected: 'b' }), {
    version: '1.0.1-rc.0', resumed: true,
  })
})

test('plan refuses to re-release a tagged commit with nothing new', () => {
  const job = { tags: ['v0.5.1', 'v0.6.0'], headTags: ['v0.6.0'], head: 'b', parent: 'a', expected: 'b' }
  assert.throws(() => planRelease({ ...job, bump: 'patch' }), /already released as v0\.6\.0.*nothing new/)
  assert.throws(() => planRelease({ ...job, tags: ['v0.9.0', 'v1.0.0-rc.0'], headTags: ['v1.0.0-rc.0'], bump: 'preminor' }), /nothing new/)
})

test('plan promotes a tagged prerelease with a stable bump', () => {
  const job = { tags: ['v1.1.0', 'v1.2.0-rc.0', 'v1.2.0-rc.1'], headTags: ['v1.2.0-rc.1'], head: 'b', parent: 'a', expected: 'b' }
  assert.deepEqual(planRelease({ ...job, bump: 'patch' }), { version: '1.2.0', resumed: false })
  assert.deepEqual(planRelease({ ...job, bump: 'major' }), { version: '2.0.0', resumed: false })
  // Rerun of a promotion that changed no files: both tags on HEAD.
  assert.deepEqual(planRelease({ ...job, tags: [...job.tags, 'v1.2.0'], headTags: ['v1.2.0-rc.1', 'v1.2.0'], bump: 'patch' }), {
    version: '1.2.0', resumed: true,
  })
})

test('plan recovers the release tag of the tested commit after the branch moved', () => {
  const tagCommits = [
    { name: 'v0.5.1', commit: 'x', parent: 'w' },
    { name: 'v0.6.0', commit: 'r', parent: 'a' },
  ]
  const job = { tags: ['v0.5.1', 'v0.6.0'], headTags: [], bump: 'minor', head: 'm', parent: 'r', expected: 'a', tagCommits }
  assert.deepEqual(planRelease(job), { version: '0.6.0', resumed: true, checkout: 'r' })
  assert.deepEqual(planRelease({ ...job, expected: 'x' }), { version: '0.5.1', resumed: true, checkout: 'x' })
  assert.throws(() => planRelease({ ...job, expected: 'q' }), /the branch moved/)
})

test('plan refuses a branch that moved after the tested commit', () => {
  assert.throws(() => planRelease({ tags: [], headTags: [], bump: 'patch', head: 'b', parent: 'a', expected: 'a' }), /the branch moved/)
  assert.throws(
    () => planRelease({ tags: ['v1.0.0'], headTags: ['v1.0.0'], bump: 'patch', head: 'c', parent: null, expected: 'a' }),
    /not the commit this run tested/,
  )
})

test('workspace manifests follow pnpm-workspace.yaml', () => {
  const patterns = workspacePatterns('packages:\n  - module\n  - "packages/*"\n  - \'!packages/skip\'\n\noverrides:\n  - nope\n')
  assert.deepEqual(patterns, ['module', 'packages/*', '!packages/skip'])
  const files = [
    'package.json', 'module/package.json', 'packages/a/package.json', 'packages/skip/package.json',
    'packages/a/test/fixture/package.json', 'tests/fixture/package.json',
  ]
  assert.deepEqual(workspaceManifests(files, patterns), ['package.json', 'module/package.json', 'packages/a/package.json'])
})

test('json version keeps formatting and skips manifests without one', () => {
  const text = '{\n    "name": "x",\n    "version": "0.1.0",\n    "dependencies": { "y": "1.0.0" }\n}\n'
  assert.equal(setJsonVersion(text, '0.2.0'), text.replace('0.1.0', '0.2.0'))
  assert.equal(setJsonVersion('{\n  "private": true\n}\n', '0.2.0'), null)
})

test('cargo version only touches the package tables', () => {
  const text = '[package]\nname = "x"\nauthors = ["a"]\nversion = "0.1.0"\n\n[dependencies]\ny = { version = "1.0.0" }\n'
  assert.equal(setCargoVersion(text, '0.2.0'), text.replace('"0.1.0"', '"0.2.0"'))
  const workspace = '[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nversion = "0.1.0"\n'
  assert.equal(setCargoVersion(workspace, '0.2.0'), workspace.replace('0.1.0', '0.2.0'))
  assert.equal(setCargoVersion('[dependencies]\ny = "1"\n', '0.2.0'), null)
  assert.equal(setCargoVersion('[package]\nname = "m"\nversion.workspace = true\n', '0.2.0'), null)
})

test('cargo workspace members that inherit the version are found', () => {
  const root = '[workspace]\nmembers = [\n  "crates/*",\n  "cli",\n]\nexclude = ["crates/skip"]\n\n[workspace.package]\nversion = "1.0.0"\n'
  const workspace = cargoWorkspace(root)
  assert.deepEqual(workspace, { members: ['crates/*', 'cli'], exclude: ['crates/skip'] })
  assert.deepEqual(cargoMemberDirs(workspace, ['', 'crates/a', 'crates/skip', 'cli', 'other']), ['crates/a', 'cli'])
  assert.equal(cargoWorkspace('[package]\nname = "x"\n'), null)
  assert.equal(cargoInheritsVersion('[package]\nname = "a"\nversion.workspace = true\n'), true)
  assert.equal(cargoInheritsVersion('[package]\nname = "a"\nversion = { workspace = true }\n'), true)
  assert.equal(cargoInheritsVersion('[package]\nname = "a"\nversion = "1.0.0"\n'), false)
})

test('plain version file keeps its trailing newline and refuses other content', () => {
  assert.equal(setTextVersion('0.7.1\n', '0.7.2'), '0.7.2\n')
  assert.equal(setTextVersion('0.7.1-rc.0', '0.7.2'), '0.7.2')
  assert.equal(setTextVersion('version: 0.7.1\n', '0.7.2'), null)
})

test('cargo lock bumps only the local package', () => {
  const lock = [
    'version = 4', '',
    '[[package]]', 'name = "x"', 'version = "0.5.1"', 'dependencies = [', ' "y",', ']', '',
    '[[package]]', 'name = "y"', 'version = "0.5.1"', 'source = "registry+https://github.com/rust-lang/crates.io-index"', '',
  ].join('\n')
  assert.equal(setCargoLockVersions(lock, ['x'], '0.6.0'), lock.replace('name = "x"\nversion = "0.5.1"', 'name = "x"\nversion = "0.6.0"'))
  assert.equal(setCargoLockVersions(lock, ['y'], '0.6.0'), lock)
  assert.equal(cargoPackageName('[package]\nname = "x"\nversion = "1"\n'), 'x')
  assert.equal(cargoPackageName('[workspace.package]\nversion = "1"\n'), null)
})

const identity = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
}

function repository(files) {
  const cwd = mkdtempSync(join(tmpdir(), 'release-version-'))
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...identity } }).trim()
  const write = (entries) => {
    for (const [path, text] of Object.entries(entries)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true })
      writeFileSync(join(cwd, path), text)
    }
  }
  const commit = (message) => {
    git('add', '.')
    git('commit', '--quiet', '--message', message)
  }
  const run = (bump, sha, extra = {}) => {
    let out
    try {
      out = execFileSync('node', [runner], {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...identity, INPUT_BUMP: bump, GITHUB_SHA: sha, GITHUB_OUTPUT: '', ...extra },
      })
    } catch (failure) {
      out = failure.stdout
    }
    const error = /^::error::(.*)$/m.exec(out)
    if (error) throw new Error(error[1])
    return Object.fromEntries(out.split('\n').filter(line => /^[\w-]+=/.test(line)).map(line => line.split(/=(.*)/s).slice(0, 2)))
  }
  git('init', '--quiet', '--initial-branch', 'main')
  write(files)
  commit('init')
  return { cwd, git, write, commit, run, read: path => readFileSync(join(cwd, path), 'utf8') }
}

function workspaceRepository() {
  const repo = repository({
    'pnpm-workspace.yaml': 'packages:\n  - module\n  - playground\n',
    'package.json': '{\n  "private": true\n}\n',
    'module/package.json': '{\n  "name": "@scope/x",\n  "version": "0.5.1"\n}\n',
    'playground/package.json': '{\n  "name": "playground",\n  "version": "0.0.0",\n  "private": true\n}\n',
    'Cargo.toml': '[package]\nname = "x"\nversion = "0.5.1"\n',
    'Cargo.lock': 'version = 4\n\n[[package]]\nname = "x"\nversion = "0.5.1"\n',
    'VERSION': '0.5.1\n',
  })
  repo.git('tag', 'v0.5.1')
  repo.write({ 'README.md': 'change\n' })
  repo.commit('feat: change')
  return repo
}

test('run commits and tags the bump, then resumes on a repeated run', () => {
  const { git, run, read } = workspaceRepository()
  const tested = git('rev-parse', 'HEAD')
  const files = { 'INPUT_FILES': 'Cargo.toml\nVERSION' }

  const first = run('minor', tested, files)
  assert.equal(first.version, '0.6.0')
  assert.equal(first.tag, 'v0.6.0')
  assert.equal(first.resumed, 'false')
  assert.equal(first.prerelease, 'false')
  assert.equal(first.packages, '["module"]')
  assert.equal(first.sha, git('rev-parse', 'HEAD'))
  assert.equal(git('rev-parse', 'HEAD^'), tested)
  assert.equal(git('rev-parse', 'v0.6.0^{commit}'), first.sha)
  assert.equal(git('cat-file', '-t', 'v0.6.0'), 'tag')
  assert.equal(git('log', '-1', '--format=%s %an'), 'chore(release): v0.6.0 github-actions[bot]')
  assert.equal(git('status', '--porcelain'), '')
  assert.equal(JSON.parse(read('module/package.json')).version, '0.6.0')
  assert.equal(JSON.parse(read('playground/package.json')).version, '0.6.0')
  assert.match(read('Cargo.toml'), /version = "0\.6\.0"/)
  assert.match(read('Cargo.lock'), /name = "x"\nversion = "0\.6\.0"/)
  assert.equal(read('VERSION'), '0.6.0\n')
  assert.equal(read('package.json'), '{\n  "private": true\n}\n')

  const again = run('minor', tested, files)
  assert.deepEqual(again, { ...first, resumed: 'true' })
  assert.equal(git('rev-parse', 'HEAD'), first.sha)
})

test('run refuses when the branch moved after the tested commit', () => {
  const { git, write, commit, run, read } = workspaceRepository()
  const tested = git('rev-parse', 'HEAD')
  write({ 'README.md': 'later\n' })
  commit('feat: later')
  const head = git('rev-parse', 'HEAD')
  const files = ['module/package.json', 'Cargo.toml', 'Cargo.lock', 'VERSION', 'README.md']
  const before = files.map(read)
  assert.throws(() => run('patch', tested), /the branch moved/)
  assert.equal(git('rev-parse', 'HEAD'), head)
  assert.equal(git('tag', '--list'), 'v0.5.1')
  assert.equal(git('status', '--porcelain'), '')
  assert.deepEqual(files.map(read), before)
})

test('run releases a single-commit repository and a prerelease', () => {
  const { git, run, read } = repository({ 'package.json': '{\n  "name": "solo",\n  "version": "0.0.0"\n}\n' })
  const tested = git('rev-parse', 'HEAD')
  const result = run('prerelease', tested, { INPUT_PREID: 'beta' })
  assert.equal(result.version, '0.0.1-beta.0')
  assert.equal(result.prerelease, 'true')
  assert.equal(result.packages, '["."]')
  assert.equal(JSON.parse(read('package.json')).version, '0.0.1-beta.0')
  assert.equal(run('prerelease', tested, { INPUT_PREID: 'beta' }).resumed, 'true')

  const bare = repository({ 'README.md': 'x\n' })
  const head = bare.git('rev-parse', 'HEAD')
  const tagged = bare.run('patch', head)
  assert.equal(tagged.sha, head, 'nothing to bump: the tested commit itself is tagged')
  assert.equal(bare.run('patch', head).resumed, 'true')
})

test('run bumps cargo workspace members that inherit the version', () => {
  const { git, write, commit, run, read } = repository({
    'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nversion = "1.0.0"\n\n[workspace.dependencies]\na = { path = "crates/a", version = "1.0.0" }\n',
    'crates/a/Cargo.toml': '[package]\nname = "a"\nversion.workspace = true\n',
    'crates/b/Cargo.toml': '[package]\nname = "b"\nversion = "9.9.9"\n',
    'Cargo.lock': 'version = 4\n\n[[package]]\nname = "a"\nversion = "1.0.0"\n\n[[package]]\nname = "b"\nversion = "9.9.9"\n',
  })
  git('tag', 'v1.0.0')
  write({ 'README.md': 'change\n' })
  commit('feat: change')
  const result = run('patch', git('rev-parse', 'HEAD'), { INPUT_FILES: 'Cargo.toml' })
  assert.equal(result.version, '1.0.1')
  assert.match(read('Cargo.toml'), /\[workspace\.package\]\nversion = "1\.0\.1"/)
  assert.match(read('Cargo.toml'), /a = \{ path = "crates\/a", version = "1\.0\.1" \}/)
  assert.match(read('Cargo.lock'), /name = "a"\nversion = "1\.0\.1"/)
  assert.match(read('Cargo.lock'), /name = "b"\nversion = "9\.9\.9"/)
})

test('run honors working-directory and reports packages from the repository root', () => {
  const sibling = '{\n  "name": "lib",\n  "version": "1.0.0"\n}\n'
  const { git, write, commit, run, read } = repository({
    'app/package.json': '{\n  "name": "app",\n  "version": "1.0.0"\n}\n',
    'lib/package.json': sibling,
  })
  git('tag', 'v1.0.0')
  write({ 'app/README.md': 'change\n' })
  commit('feat: change')
  const result = run('major', git('rev-parse', 'HEAD'), { 'INPUT_WORKING-DIRECTORY': 'app' })
  assert.equal(result.version, '2.0.0')
  assert.equal(result.packages, '["app"]')
  assert.equal(JSON.parse(read('app/package.json')).version, '2.0.0')
  assert.equal(read('lib/package.json'), sibling)
  assert.equal(git('status', '--porcelain'), '')
})

test('json version finds the top-level key in any layout', () => {
  const nested = '{"name":"x","config":{"version":"9"},"version":"0.1.0"}'
  assert.equal(setJsonVersion(nested, '0.2.0'), '{"name":"x","config":{"version":"9"},"version":"0.2.0"}')
})

test('workspace path dependencies pinned to the old version follow the bump', () => {
  const root = [
    '[workspace.package]', 'version = "1.0.0"', '',
    '[workspace.dependencies]',
    'a = { path = "crates/a", version = "1.0.0" }',
    'b = { path = "crates/b", version = "=1.0.0" }',
    'c = { path = "crates/c", version = "0.3.0" }',
    'serde = { version = "1.0.0", features = ["derive"] }',
    'd = { path = "crates/d" }', '',
    '[dependencies]', 'x = { path = "x", version = "1.0.0" }', '',
  ].join('\n')
  assert.equal(cargoVersion(root), '1.0.0')
  assert.equal(setCargoPathDependencyVersions(root, '1.0.0', '1.1.0'), root
    .replace('crates/a", version = "1.0.0"', 'crates/a", version = "1.1.0"')
    .replace('version = "=1.0.0"', 'version = "=1.1.0"'))
  assert.equal(setCargoPathDependencyVersions('[package]\nname = "x"\n', '1.0.0', '1.1.0'), '[package]\nname = "x"\n')
})

test('run promotes a prerelease with a new commit, or a second tag when no file changes', () => {
  const { git, run, read } = repository({ 'package.json': '{\n  "name": "solo",\n  "version": "0.0.0"\n}\n' })
  const rc = run('prerelease', git('rev-parse', 'HEAD'))
  assert.equal(rc.version, '0.0.1-rc.0')
  const promoted = run('patch', rc.sha)
  assert.equal(promoted.version, '0.0.1')
  assert.equal(promoted.resumed, 'false')
  assert.equal(git('rev-parse', 'HEAD^'), rc.sha)
  assert.equal(JSON.parse(read('package.json')).version, '0.0.1')
  assert.equal(run('patch', rc.sha).resumed, 'true')

  const bare = repository({ 'README.md': 'x\n' })
  const head = bare.git('rev-parse', 'HEAD')
  assert.equal(bare.run('prerelease', head).version, '0.0.1-rc.0')
  const stable = bare.run('minor', head)
  assert.deepEqual([stable.version, stable.sha, stable.resumed], ['0.1.0', head, 'false'])
  assert.equal(bare.git('tag', '--points-at', 'HEAD'), 'v0.0.1-rc.0\nv0.1.0')
  assert.equal(bare.run('minor', head).resumed, 'true')
  assert.throws(() => bare.run('patch', head), /already released as v0\.1\.0/)
})

test('run resumes the release of the tested commit after the branch moved', () => {
  const { git, write, commit, run } = workspaceRepository()
  const tested = git('rev-parse', 'HEAD')
  const first = run('minor', tested, { INPUT_FILES: 'VERSION' })
  write({ 'later.txt': 'x\n' })
  commit('feat: later')
  const again = run('minor', tested, { INPUT_FILES: 'VERSION' })
  assert.deepEqual(again, { ...first, resumed: 'true' })
  assert.equal(git('rev-parse', 'HEAD'), first.sha)
})

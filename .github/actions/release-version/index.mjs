import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { input, lines, run, setOutput } from '../_lib/core.mjs'
import { git, gitTry } from '../_lib/git.mjs'
import {
  cargoInheritsVersion, cargoMemberDirs, cargoPackageName, cargoVersion, cargoWorkspace, planRelease, setCargoLockVersions,
  setCargoPathDependencyVersions, setCargoVersion, setJsonVersion, setTextVersion, workspaceManifests, workspacePatterns,
} from './version.mjs'

const BOT = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' }

await run(() => {
  const workingDirectory = input('working-directory') || '.'
  process.chdir(workingDirectory)
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: BOT.name, GIT_AUTHOR_EMAIL: BOT.email, GIT_COMMITTER_NAME: BOT.name, GIT_COMMITTER_EMAIL: BOT.email,
  })

  const head = git('rev-parse', 'HEAD')
  const plan = planRelease({
    tags: lines(git('tag', '--list', 'v*')),
    headTags: lines(git('tag', '--points-at', 'HEAD')),
    bump: input('bump', { required: true }),
    preid: input('preid') || 'rc',
    head,
    parent: gitTry('rev-parse', '--verify', '--quiet', 'HEAD^'),
    expected: process.env.GITHUB_SHA ?? '',
  })
  const { version } = plan

  const patterns = existsSync('pnpm-workspace.yaml') ? workspacePatterns(readFileSync('pnpm-workspace.yaml', 'utf8')) : []
  const manifests = workspaceManifests(lines(git('ls-files', 'package.json', '*/package.json')), patterns)
  const extra = lines(input('files'))
  const cargoFiles = lines(git('ls-files', 'Cargo.toml', '*/Cargo.toml'))

  const changed = []
  const publishable = []
  const crates = new Set()
  for (const file of [...new Set([...manifests, ...extra])]) {
    const text = readFileSync(file, 'utf8')
    const isCargo = file.endsWith('.toml')
    const isJson = file.endsWith('.json')
    const next = isCargo
      ? setCargoVersion(setCargoPathDependencyVersions(text, cargoVersion(text), version), version)
      : isJson ? setJsonVersion(text, version) : setTextVersion(text, version)
    if (next === null && !(isCargo && cargoInheritsVersion(text))) {
      if (extra.includes(file)) throw new Error(`${file} has no version to set`)
      continue
    }
    if (next !== null && next !== text) {
      writeFileSync(file, next)
      changed.push(file)
    }
    if (isCargo) {
      const name = cargoPackageName(text)
      if (name) crates.add(name)
      const workspace = cargoWorkspace(text)
      if (workspace) {
        const root = dirname(file)
        const dirs = cargoFiles.map(path => posix.relative(root, dirname(path))).filter(dir => !dir.startsWith('..'))
        for (const dir of cargoMemberDirs(workspace, dirs)) {
          const member = readFileSync(join(root, dir, 'Cargo.toml'), 'utf8')
          const memberName = cargoPackageName(member)
          if (memberName && cargoInheritsVersion(member)) crates.add(memberName)
        }
      }
    } else if (isJson && JSON.parse(next ?? text).private !== true) {
      publishable.push(posix.join(workingDirectory, dirname(file)))
    }
  }

  if (crates.size > 0 && existsSync('Cargo.lock')) {
    const text = readFileSync('Cargo.lock', 'utf8')
    const next = setCargoLockVersions(text, [...crates], version)
    if (next !== text) {
      writeFileSync('Cargo.lock', next)
      changed.push('Cargo.lock')
    }
  }

  if (plan.resumed && changed.length > 0) {
    throw new Error(`v${version} is already tagged but ${changed.join(', ')} carry another version`)
  }
  if (changed.length > 0) {
    git('add', '--', ...changed)
    git('-c', 'commit.gpgSign=false', 'commit', '--no-verify', '--message', `chore(release): v${version}`)
  }
  if (!plan.resumed) git('-c', 'tag.gpgSign=false', 'tag', '--annotate', `v${version}`, '--message', `v${version}`)

  setOutput('version', version)
  setOutput('tag', `v${version}`)
  setOutput('sha', git('rev-parse', 'HEAD'))
  setOutput('resumed', plan.resumed)
  setOutput('prerelease', version.includes('-'))
  setOutput('packages', publishable)
})

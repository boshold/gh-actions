import { format, inc, latestTag, parse } from '../_lib/semver.mjs'

// A tagged release commit is resumed instead of bumped again, so a run that failed after the
// push can be repeated until every target is published.
export function planRelease({ tags, headTags, bump, preid = 'rc', head, parent, expected }) {
  inc(parse('0.0.0'), bump, preid)
  const resumed = latestTag(headTags)
  if (resumed) {
    if (head !== expected && parent !== expected) {
      throw new Error(`${head} is tagged v${format(resumed)} but is not the commit this run tested (${expected})`)
    }
    return { version: format(resumed), resumed: true }
  }
  if (head !== expected) {
    throw new Error(`the branch moved to ${head} after this run tested ${expected}; start a new release`)
  }
  return { version: format(inc(latestTag(tags) ?? parse('0.0.0'), bump, preid)), resumed: false }
}

// Workspace globs as pnpm-workspace.yaml writes them: `dir`, `dir/*`, `dir/**`; `!` excludes.
export function workspacePatterns(yaml) {
  const patterns = []
  let inside = false
  for (const line of yaml.split('\n')) {
    if (/^packages:\s*$/.test(line)) { inside = true; continue }
    if (!inside) continue
    const item = /^\s+-\s+['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(line)
    if (item) patterns.push(item[1])
    else if (/^\S/.test(line)) inside = false
  }
  return patterns
}

export function globToRegExp(glob) {
  const escaped = glob.replace(/^\.\//, '').replace(/\/+$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`)
}

function matchesAny(dir, include, exclude) {
  return include.some(glob => globToRegExp(glob).test(dir)) && !exclude.some(glob => globToRegExp(glob).test(dir))
}

export function workspaceManifests(files, patterns) {
  const include = patterns.filter(pattern => !pattern.startsWith('!'))
  const exclude = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1))
  return files.filter((file) => {
    if (file === 'package.json') return true
    if (!file.endsWith('/package.json')) return false
    return matchesAny(file.slice(0, -'/package.json'.length), include, exclude)
  })
}

// Returns null when the manifest carries no version, so version-less roots stay untouched.
// Edits the top-level "version" in place (keeps formatting), whatever the layout.
export function setJsonVersion(text, version) {
  const manifest = JSON.parse(text)
  if (typeof manifest.version !== 'string') return null
  const rest = JSON.stringify({ ...manifest, version })
  for (const match of text.matchAll(/("version"\s*:\s*)"[^"]*"/g)) {
    const next = text.slice(0, match.index) + `${match[1]}"${version}"` + text.slice(match.index + match[0].length)
    try {
      if (JSON.stringify(JSON.parse(next)) === rest) return next
    } catch {}
  }
  throw new Error('the top-level "version" could not be located')
}

// Body range of a TOML table, up to the next table header.
function tomlTable(text, name) {
  const header = new RegExp(`^\\[${name.replaceAll('.', '\\.')}\\][ \\t]*(?:#.*)?$`, 'm').exec(text)
  if (!header) return null
  const start = header.index + header[0].length
  const next = /^[ \t]*\[/m.exec(text.slice(start))
  return { start, end: next ? start + next.index : text.length, body: text.slice(start, next ? start + next.index : undefined) }
}

export function setCargoVersion(text, version) {
  let next = text
  let found = false
  for (const name of ['package', 'workspace.package']) {
    const table = tomlTable(next, name)
    const pattern = /^(version\s*=\s*)"[^"]*"/m
    if (!table || !pattern.test(table.body)) continue
    found = true
    next = next.slice(0, table.start) + table.body.replace(pattern, `$1"${version}"`) + next.slice(table.end)
  }
  return found ? next : null
}

export function cargoVersion(text) {
  for (const name of ['workspace.package', 'package']) {
    const version = /^version\s*=\s*"([^"]*)"/m.exec(tomlTable(text, name)?.body ?? '')?.[1]
    if (version) return version
  }
  return null
}

// Inline `[workspace.dependencies]` entries with a `path` that pin the old version (any operator).
export function setCargoPathDependencyVersions(text, previous, version) {
  const table = tomlTable(text, 'workspace.dependencies')
  if (!table || !previous) return text
  const body = table.body.replace(/^([\w-]+\s*=\s*\{[^}\n]*\})/gm, (entry) => {
    if (!/\bpath\s*=/.test(entry)) return entry
    return entry.replace(/(\bversion\s*=\s*")([=^~]?)([^"]*)"/, (match, head, operator, pinned) =>
      (pinned === previous ? `${head}${operator}${version}"` : match))
  })
  return text.slice(0, table.start) + body + text.slice(table.end)
}

export function cargoPackageName(text) {
  return /^name\s*=\s*"([^"]+)"/m.exec(tomlTable(text, 'package')?.body ?? '')?.[1] ?? null
}

export function cargoInheritsVersion(text) {
  return /^version(?:\.workspace\s*=\s*true|\s*=\s*\{\s*workspace\s*=\s*true\s*\})/m.test(tomlTable(text, 'package')?.body ?? '')
}

export function cargoWorkspace(text) {
  const table = tomlTable(text, 'workspace')
  if (!table) return null
  const list = key => [...(new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm').exec(table.body)?.[1] ?? '').matchAll(/"([^"]+)"/g)]
    .map(match => match[1])
  return { members: list('members'), exclude: list('exclude') }
}

// Member directories (relative to the workspace root) whose Cargo.toml lives in `dirs`.
export function cargoMemberDirs(workspace, dirs) {
  return dirs.filter(dir => dir !== '' && matchesAny(dir, workspace.members, workspace.exclude))
}

// Only local packages carry no `source`, so a registry crate with the same name stays untouched.
export function setCargoLockVersions(text, names, version) {
  return text.split(/(?=^\[\[package\]\]$)/m).map((block) => {
    const name = /^name = "([^"]+)"$/m.exec(block)?.[1]
    if (!name || !names.includes(name) || /^source = /m.test(block)) return block
    return block.replace(/^version = "[^"]*"$/m, `version = "${version}"`)
  }).join('')
}

// A plain version file (e.g. VERSION) holds nothing but the version.
export function setTextVersion(text, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\s*$/.test(text)) return null
  return `${version}${text.endsWith('\n') ? '\n' : ''}`
}

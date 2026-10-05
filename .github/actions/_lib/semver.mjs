const ID = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)'
const VERSION = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${ID}(?:\\.${ID})*))?$`)
export const BUMPS = ['patch', 'minor', 'major', 'prerelease', 'prepatch', 'preminor', 'premajor']

export function parse(version) {
  const match = VERSION.exec(version)
  if (!match) return null
  const pre = match[4] ? match[4].split('.').map(id => (/^\d+$/.test(id) ? Number(id) : id)) : []
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre }
}

export function format({ major, minor, patch, pre }) {
  return `${major}.${minor}.${patch}${pre.length > 0 ? `-${pre.join('.')}` : ''}`
}

export function compare(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length
  for (let i = 0; ; i++) {
    if (i >= a.pre.length || i >= b.pre.length) return a.pre.length - b.pre.length
    const [x, y] = [a.pre[i], b.pre[i]]
    if (x === y) continue
    if (typeof x !== typeof y) return typeof x === 'number' ? -1 : 1
    return x < y ? -1 : 1
  }
}

export function latestTag(tags) {
  return tags
    .map(tag => (tag.startsWith('v') ? parse(tag.slice(1)) : null))
    .filter(Boolean)
    .sort(compare)
    .at(-1) ?? null
}

// npm semver `inc` semantics.
export function inc(version, bump, preid = 'rc') {
  if (!BUMPS.includes(bump)) throw new Error(`bump must be one of ${BUMPS.join(', ')}, got "${bump}"`)
  if (bump.startsWith('pre') && (!/^[0-9A-Za-z-]+$/.test(preid) || /^\d+$/.test(preid))) {
    throw new Error(`preid must be a non-numeric identifier, got "${preid}"`)
  }
  const { major, minor, patch, pre } = version
  const isPre = pre.length > 0
  const next = (() => {
    switch (bump) {
      case 'major': return isPre && minor === 0 && patch === 0 ? [major, 0, 0] : [major + 1, 0, 0]
      case 'minor': return isPre && patch === 0 ? [major, minor, 0] : [major, minor + 1, 0]
      case 'patch': return isPre ? [major, minor, patch] : [major, minor, patch + 1]
      case 'premajor': return [major + 1, 0, 0, [preid, 0]]
      case 'preminor': return [major, minor + 1, 0, [preid, 0]]
      case 'prepatch': return [major, minor, patch + 1, [preid, 0]]
      default:
        if (!isPre) return [major, minor, patch + 1, [preid, 0]]
        if (pre.length === 2 && pre[0] === preid && typeof pre[1] === 'number') return [major, minor, patch, [preid, pre[1] + 1]]
        return [major, minor, patch, [preid, 0]]
    }
  })()
  const result = { major: next[0], minor: next[1], patch: next[2], pre: next[3] ?? [] }
  if (compare(result, version) <= 0) throw new Error(`${bump} of ${format(version)} gives ${format(result)}, which is not higher`)
  return result
}

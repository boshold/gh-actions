// Proves SQLite table rebuilds keep every column and row.
// Usage: node sqlite-columns.mjs <migration.sql> <all migration.sql files...>
// Applies the migrations sorted before <migration.sql> to a temp DB, then runs <migration.sql>
// statement by statement. Prints each table whose `DROP TABLE x` is preceded by
// `INSERT INTO "new_x" (<cols>) SELECT <same cols, same positions> FROM "x"` (no WHERE etc.).
import { readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'

const IDENT = String.raw`(?:"(?:[^"]|"")+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)`
const QUALIFIED = String.raw`(?:${IDENT}\s*\.\s*)?(${IDENT})`
const INSERT_RE = new RegExp(String.raw`^INSERT\s+INTO\s+${QUALIFIED}\s*\(([^)]*)\)\s*SELECT\s+(.+?)\s+FROM\s+${QUALIFIED}$`, 'is')
const DROP_RE = new RegExp(String.raw`^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${QUALIFIED}$`, 'i')
const BARE_RE = new RegExp(String.raw`^${IDENT}$`)

function unquote(name) {
  const first = name[0]
  if (first === '"') return name.slice(1, -1).replaceAll('""', '"')
  if (first === '`' || first === '[') return name.slice(1, -1)
  return name
}

// Splits on top-level ";" and removes comments; quotes are kept intact.
function statements(sql) {
  const out = []
  let current = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const pair = sql.slice(i, i + 2)
    if (pair === '--') {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end
      continue
    }
    if (pair === '/*') {
      const end = sql.indexOf('*/', i + 2)
      if (end === -1) throw new Error('unterminated comment')
      current += ' '
      i = end + 2
      continue
    }
    if (c === '\'' || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c
      let j = i + 1
      for (;;) {
        j = sql.indexOf(close, j)
        if (j === -1) throw new Error('unterminated quote')
        if (close !== ']' && sql[j + 1] === close) { j += 2; continue }
        break
      }
      current += sql.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (c === ';') {
      if (current.trim()) out.push(current.trim())
      current = ''
      i++
      continue
    }
    current += c
    i++
  }
  if (current.trim()) out.push(current.trim())
  return out
}

// Top-level comma split of a SELECT list.
function selectItems(list) {
  const items = []
  let depth = 0
  let current = ''
  for (const part of list.match(/"(?:[^"]|"")*"|'(?:[^']|'')*'|[^"',()]+|[(),]/g) ?? []) {
    if (part === '(') depth++
    if (part === ')') depth--
    if (part === ',' && depth === 0) {
      items.push(current.trim())
      current = ''
      continue
    }
    current += part
  }
  items.push(current.trim())
  return items
}

function main() {
  const [target, ...all] = process.argv.slice(2)
  if (!target) throw new Error('usage: sqlite-columns.mjs <migration.sql> <migration files...>')
  const name = basename(dirname(target))
  const dir = (file) => basename(dirname(file))
  const before = all.filter(file => dir(file) < name).sort((a, b) => (dir(a) < dir(b) ? -1 : 1))

  const db = new DatabaseSync(':memory:')
  for (const file of before) db.exec(readFileSync(file, 'utf8'))

  const inserts = new Map()
  const proven = []
  for (const statement of statements(readFileSync(target, 'utf8'))) {
    const insert = INSERT_RE.exec(statement)
    if (insert) {
      const column = (item) => BARE_RE.test(item) ? unquote(item).toLowerCase() : null
      inserts.set(unquote(insert[1]).toLowerCase(), {
        source: unquote(insert[4]).toLowerCase(),
        targets: selectItems(insert[2]).map(column),
        sources: selectItems(insert[3]).map(item => item === '*' ? '*' : column(item)),
      })
    }
    const drop = DROP_RE.exec(statement)
    if (drop) {
      const table = unquote(drop[1])
      const copy = inserts.get(`new_${table}`.toLowerCase())
      if (copy?.source === table.toLowerCase()) {
        const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(row => String(row.name))
        // `SELECT *` stands for the old columns in table order
        const sources = copy.sources.length === 1 && copy.sources[0] === '*' ? columns.map(c => c.toLowerCase()) : copy.sources
        // Each old column must land in the destination column of the same name, copied unchanged
        const lost = columns.filter((c) => {
          const at = copy.targets.indexOf(c.toLowerCase())
          return copy.targets.length !== sources.length || at === -1 || sources[at] !== c.toLowerCase()
        })
        if (columns.length && !lost.length) proven.push(table)
        else console.error(`${target}: rebuild of ${table} does not copy: ${lost.join(', ') || '(table unknown)'}`)
      }
    }
    db.exec(statement)
  }
  for (const table of proven) console.log(table)
}

try {
  main()
}
catch (error) {
  console.error(`sqlite-columns: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

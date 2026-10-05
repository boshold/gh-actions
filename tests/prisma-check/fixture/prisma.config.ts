import process from 'node:process'
import { defineConfig } from 'prisma/config'

// Same layout as a dual-provider app: DATABASE_URL `file:` selects the SQLite tree.
const url = process.env.DATABASE_URL ?? ''
const root = url.startsWith('file:') ? 'prisma/sqlite' : 'prisma/postgresql'

export default defineConfig({
  schema: `${root}/schema.prisma`,
  migrations: { path: `${root}/migrations` },
  datasource: { url },
})

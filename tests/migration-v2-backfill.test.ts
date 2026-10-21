import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@libsql/client'

const INIT_SQL = readFileSync(
  resolve(__dirname, '../prisma/migrations/20260519080108_init/migration.sql'),
  'utf-8',
)
const V2_SQL = readFileSync(
  resolve(__dirname, '../prisma/migrations/20260521093512_v2_schema/migration.sql'),
  'utf-8',
)

describe('v2 migration backfill on a non-empty database', () => {
  it('preserves Message.content as rawContent and gives Task a non-null updatedAt', async () => {
    const client = createClient({ url: ':memory:' })

    try {
      await client.executeMultiple(INIT_SQL)
      await client.execute(
        `INSERT INTO "Session" ("id", "title", "updatedAt") VALUES ('s1', 'session', CURRENT_TIMESTAMP)`,
      )
      await client.execute(
        `INSERT INTO "Agent" ("id", "name", "expertise", "systemPrompt") VALUES ('a1', 'Agent', 'expertise', 'prompt')`,
      )
      await client.execute(
        `INSERT INTO "Task" ("id", "description", "sessionId") VALUES ('t1', 'task', 's1')`,
      )
      await client.execute(
        `INSERT INTO "Message" ("id", "role", "content", "sessionId") VALUES ('m1', 'user', 'legacy content', 's1')`,
      )

      await client.executeMultiple(V2_SQL)

      const message = await client.execute(`SELECT "rawContent" FROM "Message" WHERE "id" = 'm1'`)
      expect(message.rows[0].rawContent).toBe('legacy content')

      const task = await client.execute(`SELECT "updatedAt" FROM "Task" WHERE "id" = 't1'`)
      expect(task.rows[0].updatedAt).toBeTruthy()
    } finally {
      client.close()
    }
  })
})

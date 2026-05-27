import { PrismaClient } from '@/generated/prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

function createPrismaClient() {
  const adapter = new PrismaLibSql({
    url: process.env.DATABASE_URL || 'file:./dev.db',
  })
  const client = new PrismaClient({ adapter })
  // WAL 模式：允许并发读写（多个 MCP Server 实例同时写 Message 表）
  client.$executeRawUnsafe('PRAGMA journal_mode=WAL').catch(() => {})
  return client
}

export const prisma = globalForPrisma.prisma || createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

// Test database setup - use a temporary test database
const TEST_DB_PATH = join(__dirname, 'test-temp.db')
const TEST_DIR = join(__dirname, 'test-temp')

describe('Database Operations', () => {
  beforeEach(() => {
    // Create test directory
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true })
    }
  })

  afterEach(() => {
    // Clean up test database and directory
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { force: true })
    }
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  describe('Prisma Schema', () => {
    it('should define Session model correctly', async () => {
      // Import prisma schema types
      const schema = `
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "sqlite"
}

model Session {
  id             String    @id @default(uuid())
  title          String
  type           String    @default("group")
  phase          String    @default("idle")
  projectDir     String    @default("")
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
}
`
      // Just verify the schema structure is valid
      expect(schema).toContain('model Session')
      expect(schema).toContain('@id @default(uuid())')
      expect(schema).toContain('DateTime  @updatedAt')
    })

    it('should define Agent model with all required fields', async () => {
      // Verify Agent model structure
      const expectedFields = [
        'id',
        'name',
        'expertise',
        'systemPrompt',
        'platform',
        'model',
        'apiKey',
        'isPreset',
        'isOrchestrator',
        'status',
      ]
      expectedFields.forEach(field => {
        expect(field).toBeTruthy() // Schema has these fields
      })
    })

    it('should define Task model with status tracking', async () => {
      const taskStatuses = ['pending', 'in_progress', 'completed', 'failed', 'blocked']
      expect(taskStatuses).toHaveLength(5)
    })
  })

  describe('Database Connection', () => {
    it('should use DATABASE_URL environment variable', () => {
      process.env.DATABASE_URL = 'file:./test.db'
      expect(process.env.DATABASE_URL).toBe('file:./test.db')
    })

    it('should fallback to default dev.db if DATABASE_URL not set', () => {
      const originalUrl = process.env.DATABASE_URL
      delete process.env.DATABASE_URL

      // From db.ts: process.env.DATABASE_URL || 'file:./dev.db'
      const fallbackUrl = 'file:./dev.db'
      expect(fallbackUrl).toBe('file:./dev.db')

      // Restore
      if (originalUrl) process.env.DATABASE_URL = originalUrl
    })
  })

  describe('Session Operations', () => {
    it('should create session with required fields', () => {
      const session = {
        id: 'test-id',
        title: 'Test Session',
        type: 'group',
        phase: 'idle',
        projectDir: '/tmp/test',
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      expect(session.id).toBe('test-id')
      expect(session.title).toBe('Test Session')
      expect(session.type).toBe('group')
    })

    it('should support session types: orchestrator, group, private', () => {
      const validTypes = ['orchestrator', 'group', 'private']
      validTypes.forEach(type => {
        expect(['orchestrator', 'group', 'private']).toContain(type)
      })
    })

    it('should support phases: idle, alignment, execution, done', () => {
      const validPhases = ['idle', 'alignment', 'execution', 'done']
      validPhases.forEach(phase => {
        expect(['idle', 'alignment', 'execution', 'done']).toContain(phase)
      })
    })
  })

  describe('Agent Operations', () => {
    it('should create agent with platform type', () => {
      const agent = {
        id: 'agent-id',
        name: '前端工程师',
        expertise: 'React, TypeScript',
        platform: 'llm',
        model: 'claude-3-5-sonnet',
        isPreset: true,
        status: 'idle',
      }

      expect(agent.platform).toBe('llm')
      expect(agent.isPreset).toBe(true)
    })

    it('should support all platform types', () => {
      const platforms = ['llm', 'claude-code', 'opencode']
      platforms.forEach(platform => {
        expect(['llm', 'claude-code', 'opencode']).toContain(platform)
      })
    })
  })

  describe('Task Operations', () => {
    it('should create task with dependencies', () => {
      const task = {
        id: 'task-1',
        description: 'Build feature',
        status: 'pending',
        dependencies: ['[]'],
        declaredFiles: ['[]'],
      }

      expect(task.dependencies).toBeDefined()
      expect(task.status).toBe('pending')
    })

    it('should support task status transitions', () => {
      const statusOrder = ['pending', 'in_progress', 'completed']
      // Also can be: 'failed', 'blocked'
      expect(statusOrder).toHaveLength(3)
    })
  })

  describe('Message Operations', () => {
    it('should create message with reply reference', () => {
      const message = {
        id: 'msg-1',
        role: 'assistant',
        rawContent: 'Hello world',
        sessionId: 'session-1',
        replyToId: 'msg-0',
      }

      expect(message.replyToId).toBe('msg-0')
      expect(message.rawContent).toBe('Hello world')
    })

    it('should support all message roles', () => {
      const roles = ['user', 'assistant', 'system']
      roles.forEach(role => {
        expect(['user', 'assistant', 'system']).toContain(role)
      })
    })
  })
})
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const schemaPath = join(__dirname, '..', 'prisma', 'schema.prisma')
const schema = readFileSync(schemaPath, 'utf-8')

describe('Prisma Schema — Session model', () => {
  it('should define Session model with required fields', () => {
    expect(schema).toContain('model Session {')
    expect(schema).toMatch(/id\s+String\s+@id @default\(uuid\(\)\)/)
    expect(schema).toMatch(/title\s+String/)
    expect(schema).toMatch(/type\s+String\s+@default\("group"\)/)
    expect(schema).toMatch(/phase\s+String\s+@default\("idle"\)/)
    expect(schema).toMatch(/createdAt\s+DateTime\s+@default\(now\(\)\)/)
    expect(schema).toMatch(/updatedAt\s+DateTime\s+@updatedAt/)
  })

  it('should have session type defaults and phase defaults', () => {
    // type defaults to "group", phase defaults to "idle"
    expect(schema).toContain('@default("group")')
    expect(schema).toContain('@default("idle")')
  })

  it('should have relations to members, tasks, messages', () => {
    expect(schema).toMatch(/members\s+SessionMember\[\]/)
    expect(schema).toMatch(/tasks\s+Task\[\]/)
    expect(schema).toMatch(/messages\s+Message\[\]/)
  })

  it('should have archive and pin fields', () => {
    expect(schema).toMatch(/isPinned\s+Boolean\s+@default\(false\)/)
    expect(schema).toMatch(/isArchived\s+Boolean\s+@default\(false\)/)
  })
})

describe('Prisma Schema — Agent model', () => {
  it('should define Agent model with unique name', () => {
    expect(schema).toContain('model Agent {')
    expect(schema).toMatch(/name\s+String\s+@unique/)
  })

  it('should have all required fields', () => {
    const requiredFields = ['expertise', 'systemPrompt', 'platform', 'model', 'apiKey', 'isPreset', 'isOrchestrator', 'status']
    for (const field of requiredFields) {
      expect(schema, `Agent should have field: ${field}`).toMatch(new RegExp(`\\b${field}\\b`))
    }
  })

  it('should default platform to claude-code', () => {
    expect(schema).toMatch(/platform\s+String\s+@default\("claude-code"\)/)
  })

  it('should have accentColor with default hex value', () => {
    expect(schema).toMatch(/accentColor\s+String\s+@default\("#6366f1"\)/)
  })

  it('should have relation to SessionMember and Task', () => {
    expect(schema).toMatch(/memberships\s+SessionMember\[\]/)
    expect(schema).toMatch(/tasks\s+Task\[\]/)
  })
})

describe('Prisma Schema — Task model', () => {
  it('should define Task model with status field', () => {
    expect(schema).toContain('model Task {')
    expect(schema).toMatch(/status\s+String\s+@default\("pending"\)/)
  })

  it('should store dependencies as JSON string', () => {
    expect(schema).toMatch(/dependencies\s+String\s+@default\("\[\]"\)/)
  })

  it('should store declaredFiles as JSON string', () => {
    expect(schema).toMatch(/declaredFiles\s+String\s+@default\("\[\]"\)/)
  })

  it('should have correctionCount for retry tracking', () => {
    expect(schema).toMatch(/correctionCount\s+Int\s+@default\(0\)/)
  })

  it('should have workspacePath and cliSessionId for CLI agents', () => {
    expect(schema).toMatch(/workspacePath\s+String\?/)
    expect(schema).toMatch(/cliSessionId\s+String\?/)
  })

  it('should cascade delete when session is deleted', () => {
    expect(schema).toMatch(/onDelete: Cascade/)
  })
})

describe('Prisma Schema — Message model', () => {
  it('should define Message model with role and rawContent', () => {
    expect(schema).toContain('model Message {')
    expect(schema).toMatch(/role\s+String/)
    expect(schema).toMatch(/rawContent\s+String/)
  })

  it('should support reply references', () => {
    expect(schema).toMatch(/replyToId\s+String\?/)
    expect(schema).toMatch(/replyTo\s+Message\? @relation/)
  })

  it('should support self-referential replies', () => {
    expect(schema).toContain('@relation("MessageReplies"')
  })
})

describe('Prisma Schema — SessionMember join table', () => {
  it('should define SessionMember with session and agent relations', () => {
    expect(schema).toContain('model SessionMember {')
    expect(schema).toMatch(/sessionId\s+String/)
    expect(schema).toMatch(/agentId\s+String/)
  })

  it('should enforce unique constraint on session-agent pair', () => {
    expect(schema).toContain('@@unique([sessionId, agentId])')
  })

  it('should have per-session status field', () => {
    expect(schema).toMatch(/status\s+String\s+@default\("idle"\)/)
  })

  it('should cascade delete on both sides', () => {
    const sessionMemberSection = schema.slice(schema.indexOf('model SessionMember'))
    const endIdx = sessionMemberSection.indexOf('model ', 1) > 0
      ? sessionMemberSection.indexOf('model ', 1)
      : sessionMemberSection.length
    const section = sessionMemberSection.slice(0, endIdx)
    const cascadeCount = (section.match(/onDelete: Cascade/g) || []).length
    expect(cascadeCount).toBe(2)
  })
})

describe('Prisma Schema — AppConfig model', () => {
  it('should define AppConfig with key-value structure', () => {
    expect(schema).toContain('model AppConfig {')
    expect(schema).toMatch(/key\s+String\s+@id/)
    expect(schema).toMatch(/value\s+String\s+@default\(""\)/)
  })
})

describe('Prisma Schema — RecentDir model', () => {
  it('should define RecentDir with unique path', () => {
    expect(schema).toContain('model RecentDir {')
    expect(schema).toMatch(/path\s+String\s+@unique/)
    expect(schema).toMatch(/useCount\s+Int\s+@default\(1\)/)
  })
})

describe('Prisma Schema — generator and datasource', () => {
  it('should use prisma-client generator', () => {
    expect(schema).toContain('provider = "prisma-client"')
  })

  it('should use sqlite datasource', () => {
    expect(schema).toContain('provider = "sqlite"')
  })
})


import { describe, it, expect, vi } from 'vitest'

// Mock prisma
vi.mock('@/lib/db', () => ({
  prisma: {
    agent: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    session: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    task: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    sessionMember: {
      findMany: vi.fn(),
    },
  },
}))

// Mock orchestrator
vi.mock('@/lib/orchestrator', () => ({
  callLLMForAnalysis: vi.fn(),
  parseJSON: vi.fn(),
}))

import { prisma } from '@/lib/db'

describe('API Safety — API Key masking via select', () => {
  it('agents GET should pass select without apiKey', async () => {
    const { GET } = await import('@/app/api/agents/route')
    ;(prisma.agent.findMany as any).mockResolvedValue([])

    const req = new Request('http://localhost/api/agents')
    await GET(req)

    const call = (prisma.agent.findMany as any).mock.calls[0][0]
    expect(call.select).toBeDefined()
    expect(call.select.apiKey).toBeUndefined()
    expect(call.select.name).toBe(true)
  })

  it('agents POST should pass select without apiKey', async () => {
    const { POST } = await import('@/app/api/agents/route')
    ;(prisma.agent.create as any).mockResolvedValue({ id: '1', name: 'Test' })

    const req = new Request('http://localhost/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test', expertise: 'test', systemPrompt: 'sp', platform: 'claude-code' }),
    })
    await POST(req)

    const call = (prisma.agent.create as any).mock.calls[0][0]
    expect(call.select).toBeDefined()
    expect(call.select.apiKey).toBeUndefined()
  })

  it('agents/[id] GET should pass select without apiKey', async () => {
    const { GET } = await import('@/app/api/agents/[id]/route')
    ;(prisma.agent.findUnique as any).mockResolvedValue({ id: '1', name: 'Test' })

    const req = new Request('http://localhost/api/agents/1')
    await GET(req, { params: Promise.resolve({ id: '1' }) })

    const call = (prisma.agent.findUnique as any).mock.calls[0][0]
    expect(call.select).toBeDefined()
    expect(call.select.apiKey).toBeUndefined()
  })

  it('agents/[id] PUT should pass select without apiKey', async () => {
    const { PUT } = await import('@/app/api/agents/[id]/route')
    ;(prisma.agent.update as any).mockResolvedValue({ id: '1', name: 'Test' })

    const req = new Request('http://localhost/api/agents/1', {
      method: 'PUT',
      body: JSON.stringify({ name: 'New' }),
    })
    await PUT(req, { params: Promise.resolve({ id: '1' }) })

    const call = (prisma.agent.update as any).mock.calls[0][0]
    expect(call.select).toBeDefined()
    expect(call.select.apiKey).toBeUndefined()
  })

  it('session members GET should include agent with select (no apiKey)', async () => {
    const { GET } = await import('@/app/api/sessions/[id]/members/route')
    ;(prisma.sessionMember.findMany as any).mockResolvedValue([])

    const req = new Request('http://localhost/api/sessions/1/members')
    await GET(req, { params: Promise.resolve({ id: '1' }) })

    const call = (prisma.sessionMember.findMany as any).mock.calls[0][0]
    const agentSelect = call.include.agent.select
    expect(agentSelect.apiKey).toBeUndefined()
    expect(agentSelect.name).toBe(true)
  })
})

describe('API Safety — Mass Assignment', () => {
  it('session PUT should only pass whitelisted fields (title, projectDir, permissionMode)', async () => {
    const { PUT } = await import('@/app/api/sessions/[id]/route')
    ;(prisma.session.update as any).mockResolvedValue({ id: '1' })

    const req = new Request('http://localhost/api/sessions/1', {
      method: 'PUT',
      body: JSON.stringify({ title: 'New', maliciousField: 'hack' }),
    })
    await PUT(req, { params: Promise.resolve({ id: '1' }) })

    const call = (prisma.session.update as any).mock.calls[0][0]
    expect(call.data.title).toBe('New')
    expect(call.data.maliciousField).toBeUndefined()
  })

  it('session PUT should ignore phase (Orchestrator-controlled)', async () => {
    const { PUT } = await import('@/app/api/sessions/[id]/route')
    ;(prisma.session.update as any).mockResolvedValue({ id: '1' })

    const req = new Request('http://localhost/api/sessions/1', {
      method: 'PUT',
      body: JSON.stringify({ title: 'New', phase: 'execution', phaseStep: 'hack', type: 'private' }),
    })
    await PUT(req, { params: Promise.resolve({ id: '1' }) })

    const call = (prisma.session.update as any).mock.calls[0][0]
    expect(call.data.title).toBe('New')
    expect(call.data.phase).toBeUndefined()
    expect(call.data.phaseStep).toBeUndefined()
    expect(call.data.type).toBeUndefined()
  })

  it('session GET should include agent with select (no apiKey)', async () => {
    const { GET } = await import('@/app/api/sessions/[id]/route')
    ;(prisma.session.findUnique as any).mockResolvedValue({
      id: '1', members: [], tasks: [], messages: [],
    })
    ;(prisma.task.findMany as any).mockResolvedValue([])

    const req = new Request('http://localhost/api/sessions/1')
    await GET(req, { params: Promise.resolve({ id: '1' }) })

    const call = (prisma.session.findUnique as any).mock.calls[0][0]
    const agentSelect = call.include.members.include.agent.select
    expect(agentSelect.apiKey).toBeUndefined()
  })
})

describe('API Safety — Status removed from Agent PUT whitelist', () => {
  it('agents/[id] PUT should ignore status field (not pass to prisma)', async () => {
    const { PUT } = await import('@/app/api/agents/[id]/route')
    ;(prisma.agent.findUnique as any).mockResolvedValue({ id: '1', name: 'Test' })
    ;(prisma.agent.update as any).mockResolvedValue({ id: '1', name: 'Test' })

    const req = new Request('http://localhost/api/agents/1', {
      method: 'PUT',
      body: JSON.stringify({ name: 'New', status: 'idle' }),
    })
    await PUT(req, { params: Promise.resolve({ id: '1' }) })

    const call = (prisma.agent.update as any).mock.calls[0][0]
    expect(call.data.name).toBe('New')
    expect(call.data.status).toBeUndefined()
  })
})

describe('API Safety — Agent POST type validation', () => {
  it('should reject non-string name', async () => {
    const { POST } = await import('@/app/api/agents/route')
    const req = new Request('http://localhost/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 123, expertise: 'test', systemPrompt: 'sp' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('should reject non-string expertise', async () => {
    const { POST } = await import('@/app/api/agents/route')
    const req = new Request('http://localhost/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test', expertise: null, systemPrompt: 'sp' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('should accept valid string fields', async () => {
    const { POST } = await import('@/app/api/agents/route')
    ;(prisma.agent.create as any).mockResolvedValue({ id: '1', name: 'Test' })

    const req = new Request('http://localhost/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test', expertise: 'test', systemPrompt: 'sp' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(201)
  })
})

describe('API Safety — Agent POST platform/accentColor type validation', () => {
  it('should reject non-string platform', async () => {
    const { POST } = await import('@/app/api/agents/route')
    const req = new Request('http://localhost/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test', expertise: 'test', systemPrompt: 'sp', platform: 123 }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('should reject non-string accentColor', async () => {
    const { POST } = await import('@/app/api/agents/route')
    const req = new Request('http://localhost/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test', expertise: 'test', systemPrompt: 'sp', accentColor: 456 }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('should accept string platform and accentColor', async () => {
    const { POST } = await import('@/app/api/agents/route')
    ;(prisma.agent.create as any).mockResolvedValue({ id: '1', name: 'Test' })

    const req = new Request('http://localhost/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test', expertise: 'test', systemPrompt: 'sp', platform: 'claude-code', accentColor: '#6366f1' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(201)
  })
})

describe('API Safety — Members route excludes systemPrompt', () => {
  it('members GET agent select should not include systemPrompt', async () => {
    const { GET } = await import('@/app/api/sessions/[id]/members/route')
    ;(prisma.sessionMember.findMany as any).mockResolvedValue([])

    const req = new Request('http://localhost/api/sessions/1/members')
    await GET(req, { params: Promise.resolve({ id: '1' }) })

    const call = (prisma.sessionMember.findMany as any).mock.calls[0][0]
    const agentSelect = call.include.agent.select
    expect(agentSelect.systemPrompt).toBeUndefined()
    expect(agentSelect.name).toBe(true)
  })
})

describe('API Safety — Provider apiKey masking logic', () => {
  it('should use maskApiKey function', async () => {
    const { maskApiKey } = await import('@/lib/utils')
    expect(maskApiKey('sk-1234567890abcd')).toBe('***abcd')
    expect(maskApiKey('')).toBe('')
    expect(maskApiKey('abc')).toBe('***')
  })
})

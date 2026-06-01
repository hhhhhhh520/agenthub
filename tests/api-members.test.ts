import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mock setup ---
const { mockFindMany, mockAgentFindUnique, mockMemberFindUnique, mockCreate, mockDelete } = vi.hoisted(() => ({
  mockFindMany: vi.fn().mockResolvedValue([]),
  mockAgentFindUnique: vi.fn(),
  mockMemberFindUnique: vi.fn(),
  mockCreate: vi.fn(),
  mockDelete: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    sessionMember: {
      findMany: mockFindMany,
      findUnique: mockMemberFindUnique,
      create: mockCreate,
      delete: mockDelete,
    },
    agent: { findUnique: mockAgentFindUnique },
  },
}))

import { GET, POST, DELETE } from '@/app/api/sessions/[id]/members/route'

// --- Helpers ---
function makeReq(method: string, body?: object, url = 'http://localhost/api/sessions/s1/members') {
  return new Request(url, {
    method,
    ...(body && { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  })
}

const params = { params: Promise.resolve({ id: 's1' }) }

beforeEach(() => {
  vi.clearAllMocks()
})

// --- Tests ---
describe('GET /api/sessions/[id]/members', () => {
  it('returns members list', async () => {
    const members = [{ id: 'm1', agent: { name: 'PM' } }]
    mockFindMany.mockResolvedValueOnce(members)
    const res = await GET(makeReq('GET'), params)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(members)
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: 's1' },
      orderBy: { joinedAt: 'asc' },
    }))
  })
})

describe('POST /api/sessions/[id]/members', () => {
  it('400 when agentId missing', async () => {
    const res = await POST(makeReq('POST', {}), params)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'agentId is required' })
  })

  it('404 when agent not found', async () => {
    mockAgentFindUnique.mockResolvedValueOnce(null)
    const res = await POST(makeReq('POST', { agentId: 'a1' }), params)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Agent not found' })
  })

  it('201 on successful creation with default role', async () => {
    const member = { id: 'm1', agentId: 'a1', role: 'member' }
    mockAgentFindUnique.mockResolvedValueOnce({ id: 'a1' })
    mockCreate.mockResolvedValueOnce(member)
    const res = await POST(makeReq('POST', { agentId: 'a1' }), params)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual(member)
    expect(mockCreate).toHaveBeenCalledWith({
      data: { sessionId: 's1', agentId: 'a1', role: 'member' },
      include: { agent: true },
    })
  })

  it('uses specified role when provided', async () => {
    mockAgentFindUnique.mockResolvedValueOnce({ id: 'a1' })
    mockCreate.mockResolvedValueOnce({ id: 'm1', role: 'admin' })
    await POST(makeReq('POST', { agentId: 'a1', role: 'admin' }), params)
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: { sessionId: 's1', agentId: 'a1', role: 'admin' },
    }))
  })

  it('409 on duplicate agent (P2002)', async () => {
    mockAgentFindUnique.mockResolvedValueOnce({ id: 'a1' })
    const err = new Error('Unique constraint') as Error & { code: string }
    err.code = 'P2002'
    mockCreate.mockRejectedValueOnce(err)
    const res = await POST(makeReq('POST', { agentId: 'a1' }), params)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Agent already in session' })
  })

  it('re-throws non-P2002 errors', async () => {
    mockAgentFindUnique.mockResolvedValueOnce({ id: 'a1' })
    mockCreate.mockRejectedValueOnce(new Error('db down'))
    await expect(POST(makeReq('POST', { agentId: 'a1' }), params)).rejects.toThrow('db down')
  })
})

describe('DELETE /api/sessions/[id]/members', () => {
  it('400 when agentId query param missing', async () => {
    const res = await DELETE(makeReq('DELETE', undefined, 'http://localhost/api/sessions/s1/members'), params)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'agentId query param is required' })
  })

  it('404 when member not found', async () => {
    mockMemberFindUnique.mockResolvedValueOnce(null)
    const res = await DELETE(makeReq('DELETE', undefined, 'http://localhost/api/sessions/s1/members?agentId=a1'), params)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Member not found' })
  })

  it('403 when trying to remove orchestrator', async () => {
    mockMemberFindUnique.mockResolvedValueOnce({ role: 'orchestrator' })
    const res = await DELETE(makeReq('DELETE', undefined, 'http://localhost/api/sessions/s1/members?agentId=a1'), params)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Cannot remove orchestrator' })
  })

  it('200 on successful removal', async () => {
    mockMemberFindUnique.mockResolvedValueOnce({ role: 'member' })
    mockDelete.mockResolvedValueOnce({})
    const res = await DELETE(makeReq('DELETE', undefined, 'http://localhost/api/sessions/s1/members?agentId=a1'), params)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(mockDelete).toHaveBeenCalledWith({
      where: { sessionId_agentId: { sessionId: 's1', agentId: 'a1' } },
    })
  })
})

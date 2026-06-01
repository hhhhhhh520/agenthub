import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mock setup ---
const { mockFindUnique, mockUpdate, mockDelete } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    agent: {
      findUnique: mockFindUnique,
      update: mockUpdate,
      delete: mockDelete,
    },
  },
}))

import { GET, PUT, DELETE } from '@/app/api/agents/[id]/route'

// --- Helpers ---
function makeReq(method: string, body?: object) {
  return new Request('http://localhost/api/agents/a1', {
    method,
    ...(body && { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  })
}

const params = { params: Promise.resolve({ id: 'a1' }) }

beforeEach(() => {
  vi.clearAllMocks()
})

// --- Tests ---
describe('GET /api/agents/[id]', () => {
  it('404 when agent not found', async () => {
    mockFindUnique.mockResolvedValueOnce(null)
    const res = await GET(makeReq('GET'), params)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Agent not found' })
  })

  it('200 with agent data', async () => {
    const agent = { id: 'a1', name: 'PM', expertise: 'product' }
    mockFindUnique.mockResolvedValueOnce(agent)
    const res = await GET(makeReq('GET'), params)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(agent)
    expect(mockFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'a1' },
    }))
  })
})

describe('PUT /api/agents/[id]', () => {
  it('404 when agent not found', async () => {
    mockFindUnique.mockResolvedValueOnce(null)
    const res = await PUT(makeReq('PUT', { name: 'new' }), params)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Agent not found' })
  })

  it('partial update: only name field', async () => {
    mockFindUnique.mockResolvedValueOnce({ id: 'a1' })
    mockUpdate.mockResolvedValueOnce({ id: 'a1', name: 'new-name' })
    await PUT(makeReq('PUT', { name: 'new-name' }), params)
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { name: 'new-name' },
    }))
  })

  it('name: empty string IS set (!== undefined check)', async () => {
    mockFindUnique.mockResolvedValueOnce({ id: 'a1' })
    mockUpdate.mockResolvedValueOnce({ id: 'a1', name: '' })
    await PUT(makeReq('PUT', { name: '' }), params)
    const data = mockUpdate.mock.calls[0][0].data
    expect(data).toHaveProperty('name', '')
  })

  it('baseUrl: empty string is NOT set (truthy check)', async () => {
    mockFindUnique.mockResolvedValueOnce({ id: 'a1' })
    mockUpdate.mockResolvedValueOnce({ id: 'a1' })
    await PUT(makeReq('PUT', { baseUrl: '' }), params)
    const data = mockUpdate.mock.calls[0][0].data
    expect(data).not.toHaveProperty('baseUrl')
  })

  it('tools array is JSON.stringify-d', async () => {
    mockFindUnique.mockResolvedValueOnce({ id: 'a1' })
    mockUpdate.mockResolvedValueOnce({ id: 'a1' })
    await PUT(makeReq('PUT', { tools: ['tool1', 'tool2'] }), params)
    const data = mockUpdate.mock.calls[0][0].data
    expect(data).toHaveProperty('tools', '["tool1","tool2"]')
  })
})

describe('DELETE /api/agents/[id]', () => {
  it('404 when agent not found', async () => {
    mockFindUnique.mockResolvedValueOnce(null)
    const res = await DELETE(makeReq('DELETE'), params)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Agent not found' })
  })

  it('403 when agent is preset', async () => {
    mockFindUnique.mockResolvedValueOnce({ id: 'a1', isPreset: true })
    const res = await DELETE(makeReq('DELETE'), params)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Cannot delete preset agent' })
  })

  it('200 on successful deletion', async () => {
    mockFindUnique.mockResolvedValueOnce({ id: 'a1', isPreset: false })
    mockDelete.mockResolvedValueOnce({})
    const res = await DELETE(makeReq('DELETE'), params)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'a1' } })
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mock setup ---
const { mockFindUnique, mockUpdate, mockDelete } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    session: {
      findUnique: mockFindUnique,
      update: mockUpdate,
      delete: mockDelete,
    },
  },
}))

import { GET, PUT, DELETE } from '@/app/api/sessions/[id]/route'

// --- Helpers ---
function makeReq(method: string, body?: object) {
  return new Request('http://localhost/api/sessions/s1', {
    method,
    ...(body && { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  })
}

const params = { params: Promise.resolve({ id: 's1' }) }

beforeEach(() => {
  vi.clearAllMocks()
})

// --- Tests ---
describe('GET /api/sessions/[id]', () => {
  it('404 when session not found', async () => {
    mockFindUnique.mockResolvedValueOnce(null)
    const res = await GET(makeReq('GET'), params)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Session not found' })
  })

  it('200 with nested members/tasks/messages', async () => {
    const session = { id: 's1', members: [], tasks: [], messages: [] }
    mockFindUnique.mockResolvedValueOnce(session)
    const res = await GET(makeReq('GET'), params)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(session)
    expect(mockFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 's1' },
      include: expect.objectContaining({
        members: expect.anything(),
        tasks: true,
        messages: expect.anything(),
      }),
    }))
  })
})

describe('PUT /api/sessions/[id]', () => {
  it('only includes provided fields in data', async () => {
    mockUpdate.mockResolvedValueOnce({ id: 's1', title: 'new-title' })
    await PUT(makeReq('PUT', { title: 'new-title' }), params)
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { title: 'new-title' },
    })
  })

  it('includes multiple fields when provided', async () => {
    mockUpdate.mockResolvedValueOnce({ id: 's1' })
    await PUT(makeReq('PUT', { title: 't', projectDir: '/p', isPinned: true }), params)
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { title: 't', projectDir: '/p', isPinned: true },
    })
  })

  it('omits undefined fields from data', async () => {
    mockUpdate.mockResolvedValueOnce({ id: 's1' })
    await PUT(makeReq('PUT', { title: 't' }), params)
    const data = mockUpdate.mock.calls[0][0].data
    expect(data).not.toHaveProperty('projectDir')
    expect(data).not.toHaveProperty('permissionMode')
    expect(data).not.toHaveProperty('isPinned')
    expect(data).not.toHaveProperty('isArchived')
  })
})

describe('DELETE /api/sessions/[id]', () => {
  it('200 on successful deletion', async () => {
    mockDelete.mockResolvedValueOnce({})
    const res = await DELETE(makeReq('DELETE'), params)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(mockDelete).toHaveBeenCalledWith({ where: { id: 's1' } })
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFindMany, mockFindUnique, mockCreate, mockUpdate } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockFindUnique: vi.fn(),
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    provider: {
      findMany: mockFindMany,
      findUnique: mockFindUnique,
      create: mockCreate,
      update: mockUpdate,
    },
  },
}))

import { GET as GetList, POST as PostCreate } from '@/app/api/providers/db/route'
import { GET as GetOne, PUT as PutUpdate } from '@/app/api/providers/db/[id]/route'

const REAL_KEY = 'sk-abcdefghij1234567890XYZ'
const MASKED = '***0XYZ'

const params = (id: string) => ({ params: Promise.resolve({ id }) })
function makeReq(body: object) {
  return new Request('http://localhost/api/providers/db', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
function makePutReq(body: object) {
  return new Request('http://localhost/api/providers/db/p1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/providers/db — list masks apiKey', () => {
  it('masks apiKey in list response', async () => {
    mockFindMany.mockResolvedValueOnce([
      { id: 'p1', name: 'P1', baseUrl: 'https://api.x.com', apiKey: REAL_KEY, model: 'm1', category: 'custom', createdAt: new Date() },
      { id: 'p2', name: 'P2', baseUrl: 'https://api.y.com', apiKey: 'short', model: 'm2', category: 'custom', createdAt: new Date() },
    ])
    const res = await GetList()
    const data = await res.json()
    expect(data[0].apiKey).toBe(MASKED)
    expect(data[1].apiKey).toBe('***hort')
    expect(data[0].apiKey).not.toContain('abcdef')
  })

  it('returns empty string for empty apiKey', async () => {
    mockFindMany.mockResolvedValueOnce([
      { id: 'p1', name: 'P1', baseUrl: '', apiKey: '', model: '', category: 'custom', createdAt: new Date() },
    ])
    const res = await GetList()
    const data = await res.json()
    expect(data[0].apiKey).toBe('')
  })
})

describe('POST /api/providers/db — create returns masked', () => {
  it('masks apiKey in created provider response', async () => {
    mockCreate.mockResolvedValueOnce({
      id: 'p1', name: 'P1', baseUrl: 'https://api.x.com', apiKey: REAL_KEY,
      model: 'm1', category: 'custom', createdAt: new Date(),
    })
    const res = await PostCreate(makeReq({ name: 'P1', apiKey: REAL_KEY }))
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.apiKey).toBe(MASKED)
    expect(data.apiKey).not.toContain('abcdef')
  })
})

describe('GET /api/providers/db/[id] — single masks apiKey', () => {
  it('masks apiKey in single provider response', async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: 'p1', name: 'P1', baseUrl: 'https://api.x.com', apiKey: REAL_KEY,
      model: 'm1', category: 'custom', createdAt: new Date(),
    })
    const res = await GetOne(new Request('http://localhost/api/providers/db/p1'), params('p1'))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.apiKey).toBe(MASKED)
  })

  it('returns 404 when not found (no apiKey leak)', async () => {
    mockFindUnique.mockResolvedValueOnce(null)
    const res = await GetOne(new Request('http://localhost/api/providers/db/x'), params('x'))
    expect(res.status).toBe(404)
  })
})

describe('PUT /api/providers/db/[id] — update returns masked', () => {
  it('masks apiKey in updated provider response when apiKey changed', async () => {
    mockFindUnique.mockResolvedValueOnce({ id: 'p1' })
    mockUpdate.mockResolvedValueOnce({
      id: 'p1', name: 'P1', baseUrl: 'https://api.x.com', apiKey: REAL_KEY,
      model: 'm1', category: 'custom', createdAt: new Date(),
    })
    const res = await PutUpdate(makePutReq({ apiKey: REAL_KEY }), params('p1'))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.apiKey).toBe(MASKED)
  })

  it('preserves DB key when apiKey omitted from PUT body (contract: ...(apiKey && {apiKey}))', async () => {
    mockFindUnique.mockResolvedValueOnce({ id: 'p1' })
    mockUpdate.mockResolvedValueOnce({
      id: 'p1', name: 'P1-renamed', baseUrl: 'https://api.x.com', apiKey: REAL_KEY,
      model: 'm1', category: 'custom', createdAt: new Date(),
    })
    const res = await PutUpdate(makePutReq({ name: 'P1-renamed' }), params('p1'))
    expect(res.status).toBe(200)
    // 验证 update 调用未传 apiKey(契约保护:留空则保留原值)
    const call = mockUpdate.mock.calls[0][0]
    expect(call.data.apiKey).toBeUndefined()
    // 返回的也是掩码
    const data = await res.json()
    expect(data.apiKey).toBe(MASKED)
  })
})

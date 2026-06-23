import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockAgentCreate, mockAgentUpdate, mockAgentFind, mockProviderFind } = vi.hoisted(() => ({
  mockAgentCreate: vi.fn(),
  mockAgentUpdate: vi.fn(),
  mockAgentFind: vi.fn(),
  mockProviderFind: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    agent: { create: mockAgentCreate, update: mockAgentUpdate, findUnique: mockAgentFind },
    provider: { findUnique: mockProviderFind },
  },
}))

import { POST } from '@/app/api/agents/route'
import { PUT } from '@/app/api/agents/[id]/route'

const REAL_KEY = 'sk-real-key-from-db-1234567890'
const PROVIDER_ID = 'prov-123'

function makePostReq(body: object) {
  return new Request('http://localhost/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
function makePutReq(body: object) {
  return new Request('http://localhost/api/agents/a1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  mockAgentCreate.mockImplementation(({ data }) => Promise.resolve({ id: 'a1', ...data }))
  mockAgentUpdate.mockImplementation(({ data }) => Promise.resolve({ id: 'a1', name: 'A', ...data }))
  mockAgentFind.mockResolvedValue({ id: 'a1', isPreset: false })
})

describe('POST /api/agents — providerRef resolves real apiKey server-side', () => {
  it('with providerRef + empty apiKey: resolves and writes real key from DB', async () => {
    mockProviderFind.mockResolvedValueOnce({ id: PROVIDER_ID, apiKey: REAL_KEY, baseUrl: 'https://api.x.com', model: 'm1' })
    const res = await POST(makePostReq({
      name: 'NewAgent',
      expertise: 'test',
      systemPrompt: 'sp',
      providerRef: PROVIDER_ID,
    }))
    expect(res.status).toBe(201)
    expect(mockAgentCreate).toHaveBeenCalled()
    const call = mockAgentCreate.mock.calls[0][0]
    expect(call.data.apiKey).toBe(REAL_KEY)
  })

  it('with providerRef: ignores body.apiKey (防止前端发送 masked 字符串污染 DB)', async () => {
    mockProviderFind.mockResolvedValueOnce({ id: PROVIDER_ID, apiKey: REAL_KEY, baseUrl: 'https://api.x.com', model: 'm1' })
    const res = await POST(makePostReq({
      name: 'NewAgent',
      expertise: 'test',
      systemPrompt: 'sp',
      providerRef: PROVIDER_ID,
      apiKey: '***evil',  // 攻击者尝试覆盖
    }))
    expect(res.status).toBe(201)
    const call = mockAgentCreate.mock.calls[0][0]
    expect(call.data.apiKey).toBe(REAL_KEY)  // 真 key 来自 DB,不是 '***evil'
  })

  it('providerRef not found in DB: 400', async () => {
    mockProviderFind.mockResolvedValueOnce(null)
    const res = await POST(makePostReq({
      name: 'NewAgent',
      expertise: 'test',
      systemPrompt: 'sp',
      providerRef: 'bad-id',
    }))
    expect(res.status).toBe(400)
    expect(mockAgentCreate).not.toHaveBeenCalled()
  })

  it('providerRef as invalid type (number) returns 400', async () => {
    const res = await POST(makePostReq({
      name: 'A',
      expertise: 'e',
      systemPrompt: 's',
      providerRef: 123,  // 非法类型
    }))
    expect(res.status).toBe(400)
    expect(mockAgentCreate).not.toHaveBeenCalled()
  })

  it('no providerRef: keeps existing apiKey behavior (backward compat)', async () => {
    const res = await POST(makePostReq({
      name: 'A',
      expertise: 'e',
      systemPrompt: 's',
      apiKey: 'direct-key',
    }))
    expect(res.status).toBe(201)
    const call = mockAgentCreate.mock.calls[0][0]
    expect(call.data.apiKey).toBe('direct-key')
  })
})

describe('PUT /api/agents/[id] — providerRef resolves real apiKey', () => {
  it('with providerRef: updates apiKey with resolved key', async () => {
    mockProviderFind.mockResolvedValueOnce({ id: PROVIDER_ID, apiKey: REAL_KEY, baseUrl: 'https://api.x.com', model: 'm1' })
    const res = await PUT(makePutReq({ providerRef: PROVIDER_ID }), params('a1'))
    expect(res.status).toBe(200)
    const call = mockAgentUpdate.mock.calls[0][0]
    expect(call.data.apiKey).toBe(REAL_KEY)
  })

  it('with providerRef: ignores body.apiKey', async () => {
    mockProviderFind.mockResolvedValueOnce({ id: PROVIDER_ID, apiKey: REAL_KEY, baseUrl: 'https://api.x.com', model: 'm1' })
    const res = await PUT(makePutReq({ providerRef: PROVIDER_ID, apiKey: '***evil' }), params('a1'))
    expect(res.status).toBe(200)
    const call = mockAgentUpdate.mock.calls[0][0]
    expect(call.data.apiKey).toBe(REAL_KEY)
  })

  it('providerRef not found: 400', async () => {
    mockProviderFind.mockResolvedValueOnce(null)
    const res = await PUT(makePutReq({ providerRef: 'bad-id' }), params('a1'))
    expect(res.status).toBe(400)
    expect(mockAgentUpdate).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks ---
const { mockFindMany, mockCreate, mockRecentDirUpsert, mockAgentFindMany, mockSessionMemberCreateMany } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockCreate: vi.fn(),
  mockRecentDirUpsert: vi.fn(),
  mockAgentFindMany: vi.fn(),
  mockSessionMemberCreateMany: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    session: { findMany: mockFindMany, create: mockCreate },
    recentDir: { upsert: mockRecentDirUpsert },
    agent: { findMany: mockAgentFindMany },
    sessionMember: { createMany: mockSessionMemberCreateMany },
  },
}))

import { GET, POST } from '@/app/api/sessions/route'

function makeReq(url = 'http://localhost/api/sessions') {
  return new Request(url)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCreate.mockResolvedValue({ id: 's1' })
  mockAgentFindMany.mockResolvedValue([])
  mockSessionMemberCreateMany.mockResolvedValue({ count: 0 })
})

describe('GET /api/sessions（列表）', () => {
  it('P4 T5 审查整改: findMany omit decisionTrace——列表是仪表盘轮询端点,不发内部审计', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: 's1', decisionTrace: '["x"]' }])
    const res = await GET(makeReq())
    expect(res.status).toBe(200)
    // 回归守卫: 列表查询必须 omit decisionTrace(移除则红)——剥离由 prisma 查询层执行,防大 payload + 泄漏
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({
      omit: { decisionTrace: true },
    }))
  })

  it('archived 过滤参数透传', async () => {
    mockFindMany.mockResolvedValueOnce([])
    await GET(makeReq('http://localhost/api/sessions?archived=true'))
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {}, // archived=true 不过滤
      omit: { decisionTrace: true },
    }))
  })
})

describe('POST /api/sessions — P3 #5 permissionMode 校验', () => {
  function makePostReq(body: Record<string, unknown>) {
    return new Request('http://localhost/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('显式非法 permissionMode 返回 400，且不创建 session', async () => {
    const res = await POST(makePostReq({ title: 'x', permissionMode: 'hack' }))
    expect(res.status).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('permissionMode=auto 仍合法，并写入 create data', async () => {
    mockCreate.mockResolvedValueOnce({ id: 's1' })
    const res = await POST(makePostReq({ title: 'x', permissionMode: 'auto' }))
    expect(res.status).toBe(200)
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ permissionMode: 'auto' }),
    }))
  })
})

describe('POST /api/sessions — P3 #17 private agentIds 先校验再建会话', () => {
  function makePostReq(body: Record<string, unknown>) {
    return new Request('http://localhost/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('private 缺 agentIds 返回 400，且不创建空会话', async () => {
    const res = await POST(makePostReq({ title: 'p', type: 'private' }))
    expect(res.status).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('private 含未知 agentId 返回 400，且不创建空会话/不写半套成员', async () => {
    mockAgentFindMany.mockResolvedValueOnce([{ id: 'a1', name: '已知', isPreset: false }])
    const res = await POST(makePostReq({ title: 'p', type: 'private', agentIds: ['a1', 'missing'] }))
    expect(res.status).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockSessionMemberCreateMany).not.toHaveBeenCalled()
  })

  it('private 全部 agentId 有效时才创建会话，且先查 agent 再 create', async () => {
    mockAgentFindMany.mockResolvedValueOnce([
      { id: 'a1', name: '甲', isPreset: false },
      { id: 'a2', name: '乙', isPreset: false },
    ])
    const res = await POST(makePostReq({ title: 'p', type: 'private', agentIds: ['a1', 'a2'] }))
    expect(res.status).toBe(200)
    expect(mockAgentFindMany.mock.invocationCallOrder[0]).toBeLessThan(mockCreate.mock.invocationCallOrder[0])
    expect(mockSessionMemberCreateMany).toHaveBeenCalledWith({
      data: [
        { sessionId: 's1', agentId: 'a1', role: 'member' },
        { sessionId: 's1', agentId: 'a2', role: 'member' },
      ],
    })
  })
})

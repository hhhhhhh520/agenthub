import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks ---
const { mockFindMany, mockCreate, mockRecentDirUpsert } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockCreate: vi.fn(),
  mockRecentDirUpsert: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    session: { findMany: mockFindMany, create: mockCreate },
    recentDir: { upsert: mockRecentDirUpsert },
  },
}))

import { GET } from '@/app/api/sessions/route'

function makeReq(url = 'http://localhost/api/sessions') {
  return new Request(url)
}

beforeEach(() => {
  vi.clearAllMocks()
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

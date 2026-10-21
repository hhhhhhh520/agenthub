import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  messageFindMany: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: { message: { findMany: mocks.messageFindMany } },
}))

vi.mock('@/lib/message-parser', () => ({
  parseMessage: (rawContent: string) => ({ text: rawContent }),
}))

import { GET } from '@/app/api/sessions/[id]/messages/route'

const params = { params: Promise.resolve({ id: 's1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.messageFindMany.mockResolvedValue([])
})

describe('GET /api/sessions/[id]/messages', () => {
  it('不返回内部 system 审批记录', async () => {
    const res = await GET(new Request('http://localhost/api/sessions/s1/messages'), params)

    expect(res.status).toBe(200)
    expect(mocks.messageFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: 's1', role: { not: 'system' } },
    }))
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  messageCount: vi.fn(),
  sessionUpdate: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    message: { count: mocks.messageCount },
    session: { update: mocks.sessionUpdate },
  },
}))

import { maybeAutoTitleSession } from '@/lib/services/session-title'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.messageCount.mockResolvedValue(0)
  mocks.sessionUpdate.mockResolvedValue({})
})

describe('maybeAutoTitleSession', () => {
  it('updates a placeholder title from the first user message', async () => {
    const title = await maybeAutoTitleSession({
      sessionId: 's1',
      currentTitle: '新会话',
      message: '帮我写一个 Python 计算器',
    })

    expect(title).toBe('帮我写一个 Python 计算器')
    expect(mocks.messageCount).toHaveBeenCalledWith({
      where: { sessionId: 's1', role: 'user' },
    })
    expect(mocks.sessionUpdate).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { title: '帮我写一个 Python 计算器' },
    })
  })

  it('keeps a manually renamed title', async () => {
    const title = await maybeAutoTitleSession({
      sessionId: 's1',
      currentTitle: '支付重构',
      message: '帮我看看这个接口',
    })

    expect(title).toBeNull()
    expect(mocks.messageCount).not.toHaveBeenCalled()
    expect(mocks.sessionUpdate).not.toHaveBeenCalled()
  })

  it('does not rename after the first user message', async () => {
    mocks.messageCount.mockResolvedValueOnce(1)

    const title = await maybeAutoTitleSession({
      sessionId: 's1',
      currentTitle: '私聊: 前端工程师',
      message: '第二个需求',
    })

    expect(title).toBeNull()
    expect(mocks.sessionUpdate).not.toHaveBeenCalled()
  })

  it('skips regenerate and attachment-only messages', async () => {
    expect(await maybeAutoTitleSession({
      sessionId: 's1', currentTitle: '新会话', message: '重新生成', regenerate: true,
    })).toBeNull()
    expect(await maybeAutoTitleSession({
      sessionId: 's1', currentTitle: '新会话', message: '',
    })).toBeNull()
    expect(mocks.messageCount).not.toHaveBeenCalled()
  })
})

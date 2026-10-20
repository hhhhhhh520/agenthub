import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  sessionFindUnique: vi.fn(),
  sessionUpdate: vi.fn(),
  attachmentFindMany: vi.fn(),
  attachmentUpdateMany: vi.fn(),
  messageCreate: vi.fn(),
  messageFindUnique: vi.fn(),
  messageUpdate: vi.fn(),
  sessionMemberFindMany: vi.fn(),
  acquireSessionLock: vi.fn(),
  releaseLock: vi.fn(),
  createEventLogger: vi.fn(),
  executeSingleAgent: vi.fn(),
  handleCreateAgent: vi.fn(),
  handleOrchestratorDecision: vi.fn(),
  handleMentionAllDiscussion: vi.fn(),
  handleDirectAgentChat: vi.fn(),
  isCreateAgentIntent: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    session: {
      findUnique: mocks.sessionFindUnique,
      update: mocks.sessionUpdate,
    },
    attachment: {
      findMany: mocks.attachmentFindMany,
      updateMany: mocks.attachmentUpdateMany,
    },
    message: {
      create: mocks.messageCreate,
      findUnique: mocks.messageFindUnique,
      update: mocks.messageUpdate,
    },
    sessionMember: {
      findMany: mocks.sessionMemberFindMany,
    },
  },
}))

vi.mock('@/lib/session-lock', () => ({
  acquireSessionLock: mocks.acquireSessionLock,
}))

vi.mock('@/lib/orchestrator', () => ({
  executeSingleAgent: mocks.executeSingleAgent,
}))

vi.mock('@/lib/services/agent-factory', () => ({
  handleCreateAgent: mocks.handleCreateAgent,
}))

vi.mock('@/lib/services/chat-router', () => ({
  handleOrchestratorDecision: mocks.handleOrchestratorDecision,
  handleMentionAllDiscussion: mocks.handleMentionAllDiscussion,
  handleDirectAgentChat: mocks.handleDirectAgentChat,
  isCreateAgentIntent: mocks.isCreateAgentIntent,
}))

vi.mock('@/lib/services/event-log', () => ({
  createEventLogger: mocks.createEventLogger,
}))

import { POST } from '@/app/api/sessions/[id]/chat/route'

const params = { params: Promise.resolve({ id: 's1' }) }
const session = {
  id: 's1',
  type: 'group',
  permissionMode: 'default',
  projectDir: '',
  phase: 'idle',
  phaseStep: '',
  decisionTrace: '[]',
}

function makeReq(body: Record<string, unknown>) {
  return new Request('http://localhost/api/sessions/s1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.sessionFindUnique.mockResolvedValue(session)
  mocks.sessionUpdate.mockResolvedValue(session)
  mocks.attachmentFindMany.mockResolvedValue([])
  mocks.attachmentUpdateMany.mockResolvedValue({ count: 0 })
  mocks.messageCreate.mockResolvedValue({ id: 'm1' })
  mocks.messageFindUnique.mockResolvedValue(null)
  mocks.messageUpdate.mockResolvedValue({})
  mocks.sessionMemberFindMany.mockResolvedValue([])
  mocks.acquireSessionLock.mockResolvedValue(mocks.releaseLock)
  mocks.createEventLogger.mockResolvedValue({
    sendEvent: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  })
  mocks.isCreateAgentIntent.mockReturnValue(false)
  mocks.handleOrchestratorDecision.mockResolvedValue(undefined)
  mocks.handleMentionAllDiscussion.mockResolvedValue(undefined)
  mocks.handleDirectAgentChat.mockResolvedValue(undefined)
  mocks.handleCreateAgent.mockResolvedValue(undefined)
  mocks.executeSingleAgent.mockResolvedValue({ result: 'ok' })
})

describe('chat route — 统一锁释放', () => {
  it('拿锁后、建流前的 DB 异常会释放锁（防永久 429）', async () => {
    mocks.attachmentFindMany.mockRejectedValueOnce(new Error('db down'))

    await expect(POST(makeReq({ message: 'hi', attachmentIds: ['a1'] }), params)).rejects.toThrow('db down')

    expect(mocks.acquireSessionLock).toHaveBeenCalledTimes(1)
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('/permission 早退分支只释放一次', async () => {
    const res = await POST(makeReq({ message: '/permission auto' }), params)
    await res.text()

    expect(res.status).toBe(200)
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('正常 SSE 流结束后由 stream.finally 释放一次', async () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    mocks.createEventLogger.mockResolvedValueOnce({ sendEvent: vi.fn(), flush })

    const res = await POST(makeReq({ message: 'hi' }), params)
    await res.text()

    expect(mocks.handleOrchestratorDecision).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('eventLogger 创建失败仍会关闭流并释放锁', async () => {
    mocks.createEventLogger.mockRejectedValueOnce(new Error('logger fail'))

    const res = await POST(makeReq({ message: 'hi' }), params)
    const text = await res.text()

    expect(text).toContain('处理消息时出错')
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('eventLogger.flush 抛错仍释放锁（flush 不能跳过 finally）', async () => {
    const flush = vi.fn().mockRejectedValueOnce(new Error('flush fail'))
    mocks.createEventLogger.mockResolvedValueOnce({ sendEvent: vi.fn(), flush })

    const res = await POST(makeReq({ message: 'hi' }), params)
    await res.text()

    expect(flush).toHaveBeenCalledTimes(1)
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('等锁超时返回 429，且不调用 release（锁从未拿到）', async () => {
    mocks.acquireSessionLock.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'SESSION_BUSY' }))

    const res = await POST(makeReq({ message: 'hi' }), params)

    expect(res.status).toBe(429)
    expect(mocks.releaseLock).not.toHaveBeenCalled()
  })
})

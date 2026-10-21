import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { requestSessionCancel, clearSessionCancel } from '@/lib/cancellation'
import { markSessionDeleting, clearSessionDeleting } from '@/lib/session-lifecycle'

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

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timeout')
    await new Promise(r => setTimeout(r, 5))
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearSessionCancel('s1')
  clearSessionDeleting('s1')
  mocks.sessionFindUnique.mockResolvedValue(session)
  mocks.sessionUpdate.mockResolvedValue(session)
  mocks.attachmentFindMany.mockResolvedValue([])
  mocks.attachmentUpdateMany.mockResolvedValue({ count: 0 })
  mocks.messageCreate.mockResolvedValue({ id: 'm1' })
  mocks.messageFindUnique.mockResolvedValue(null)
  mocks.messageUpdate.mockResolvedValue({})
  mocks.sessionMemberFindMany.mockResolvedValue([])
  mocks.acquireSessionLock.mockResolvedValue(mocks.releaseLock)
  mocks.createEventLogger.mockImplementation(async (_sessionId: string, opts?: { stream?: (e: unknown) => void }) => ({
    // 让 sendEvent 真正进 SSE stream，取消/错误帧才能在 res.text() 里断言
    sendEvent: (event: unknown) => opts?.stream?.(event),
    flush: vi.fn().mockResolvedValue(undefined),
  }))
  mocks.isCreateAgentIntent.mockReturnValue(false)
  mocks.handleOrchestratorDecision.mockResolvedValue(undefined)
  mocks.handleMentionAllDiscussion.mockResolvedValue(undefined)
  mocks.handleDirectAgentChat.mockResolvedValue(undefined)
  mocks.handleCreateAgent.mockResolvedValue(undefined)
  mocks.executeSingleAgent.mockResolvedValue({ result: 'ok' })
})

afterEach(() => {
  clearSessionCancel('s1')
  clearSessionDeleting('s1')
})

describe('chat route — P3 #15 replyToId 校验', () => {
  it('replyToId 不存在时 400，且不拿锁/不建消息', async () => {
    mocks.messageFindUnique.mockResolvedValueOnce(null)
    const res = await POST(makeReq({ message: 'hi', replyToId: 'missing' }), params)

    expect(res.status).toBe(400)
    expect(mocks.acquireSessionLock).not.toHaveBeenCalled()
    expect(mocks.messageCreate).not.toHaveBeenCalled()
  })

  it('replyToId 属于其他会话时 400，且不拿锁/不建消息', async () => {
    mocks.messageFindUnique.mockResolvedValueOnce({ sessionId: 'other-session' })
    const res = await POST(makeReq({ message: 'hi', replyToId: 'm-other' }), params)

    expect(res.status).toBe(400)
    expect(mocks.acquireSessionLock).not.toHaveBeenCalled()
    expect(mocks.messageCreate).not.toHaveBeenCalled()
  })
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

  it('P2-02: regenerate 把 sessionId 作为 chatSessionId 传给 executeSingleAgent', async () => {
    mocks.messageFindUnique.mockResolvedValue({
      id: 'm1', sessionId: 's1', rawContent: '原问题', agentId: 'PM', attachments: [],
    })
    mocks.sessionMemberFindMany.mockResolvedValue([{
      agent: {
        id: 'a1', name: 'PM', systemPrompt: 'sp', platform: 'claude-code',
        model: '', baseUrl: '', apiKey: '', tools: '[]', isOrchestrator: false,
      },
    }])

    const res = await POST(makeReq({ regenerate: 'm1' }), params)
    await res.text()

    expect(mocks.executeSingleAgent).toHaveBeenCalledTimes(1)
    expect(mocks.executeSingleAgent.mock.calls[0][4]).toBe('s1')
  })

  it('P2-02: regenerate 返回时已取消 → 不更新原消息、不发成功 done', async () => {
    mocks.messageFindUnique.mockResolvedValue({
      id: 'm1', sessionId: 's1', rawContent: '原问题', agentId: 'PM', attachments: [],
    })
    mocks.sessionMemberFindMany.mockResolvedValue([{
      agent: {
        id: 'a1', name: 'PM', systemPrompt: 'sp', platform: 'claude-code',
        model: '', baseUrl: '', apiKey: '', tools: '[]', isOrchestrator: false,
      },
    }])
    mocks.executeSingleAgent.mockImplementationOnce(async () => {
      requestSessionCancel('s1')
      return { result: '不应发布的新结果' }
    })

    const res = await POST(makeReq({ regenerate: 'm1' }), params)
    const text = await res.text()

    expect(mocks.messageUpdate).not.toHaveBeenCalled()
    expect(text).not.toContain('不应发布的新结果')
    expect(text).not.toContain('"type":"done"')
  })

  it('执行中被 cancel → 推停止帧，不推系统错误，仍释放锁', async () => {
    mocks.handleOrchestratorDecision.mockImplementationOnce(async () => {
      requestSessionCancel('s1')
      throw new Error('process killed')
    })

    const res = await POST(makeReq({ message: 'hi' }), params)
    const text = await res.text()

    expect(text).toContain('执行已停止')
    expect(text).not.toContain('处理消息时出错')
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

  it('P2-03: 删除中的会话在拿锁前拒绝新 chat', async () => {
    markSessionDeleting('s1')

    const res = await POST(makeReq({ message: 'hi' }), params)
    await res.text()

    expect(res.status).toBe(409)
    expect(mocks.acquireSessionLock).not.toHaveBeenCalled()
    expect(mocks.messageCreate).not.toHaveBeenCalled()
    expect(mocks.handleOrchestratorDecision).not.toHaveBeenCalled()
  })

  it('P2-03: 等锁期间进入 deleting → 拿锁后拒绝且不写消息', async () => {
    let resolveLock!: (release: () => void) => void
    mocks.acquireSessionLock.mockReturnValueOnce(new Promise((resolve) => {
      resolveLock = resolve
    }))

    const pending = POST(makeReq({ message: 'hi' }), params)
    await waitUntil(() => mocks.acquireSessionLock.mock.calls.length > 0)
    markSessionDeleting('s1')
    resolveLock(mocks.releaseLock)

    const res = await pending
    await res.text()

    expect(res.status).toBe(409)
    expect(mocks.messageCreate).not.toHaveBeenCalled()
    expect(mocks.handleOrchestratorDecision).not.toHaveBeenCalled()
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('P2-03: 删除完成后 session 不存在 → 404', async () => {
    mocks.sessionFindUnique.mockResolvedValueOnce(null)

    const res = await POST(makeReq({ message: 'hi' }), params)

    expect(res.status).toBe(404)
    expect(mocks.acquireSessionLock).not.toHaveBeenCalled()
  })

  it('P2-07: 等锁期间权限/工作目录变化，拿锁后使用新快照', async () => {
    const initialSession = { ...session, projectDir: '/old' }
    const freshSession = { ...session, projectDir: '/new', permissionMode: 'auto' }
    let reads = 0
    mocks.sessionFindUnique.mockImplementation(async () => {
      reads += 1
      return reads === 1 ? initialSession : freshSession
    })
    let resolveLock!: (release: () => void) => void
    mocks.acquireSessionLock.mockReturnValueOnce(new Promise((resolve) => {
      resolveLock = resolve
    }))

    const pending = POST(makeReq({ message: 'hi' }), params)
    await waitUntil(() => mocks.acquireSessionLock.mock.calls.length > 0)
    resolveLock(mocks.releaseLock)

    const res = await pending
    await res.text()

    expect(mocks.sessionFindUnique).toHaveBeenCalledTimes(2)
    expect(mocks.handleOrchestratorDecision).toHaveBeenCalledTimes(1)
    const call = mocks.handleOrchestratorDecision.mock.calls[0]
    expect(call[6]).toBe('/new')
    expect(call[7]).toBe('auto')
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('P2-07: 等锁期间 phase/decisionTrace 变化，拿锁后传给 orchestrator 的是新值', async () => {
    const initialSession = { ...session, phase: 'idle', phaseStep: '', decisionTrace: '[]' }
    const freshSession = {
      ...session,
      phase: 'alignment',
      phaseStep: 'pm_confirm',
      decisionTrace: '[{"step":"pm"}]',
    }
    let reads = 0
    mocks.sessionFindUnique.mockImplementation(async () => {
      reads += 1
      return reads === 1 ? initialSession : freshSession
    })
    let resolveLock!: (release: () => void) => void
    mocks.acquireSessionLock.mockReturnValueOnce(new Promise((resolve) => {
      resolveLock = resolve
    }))

    const pending = POST(makeReq({ message: 'hi' }), params)
    await waitUntil(() => mocks.acquireSessionLock.mock.calls.length > 0)
    resolveLock(mocks.releaseLock)

    const res = await pending
    await res.text()

    expect(mocks.sessionFindUnique).toHaveBeenCalledTimes(2)
    expect(mocks.handleOrchestratorDecision).toHaveBeenCalledTimes(1)
    const call = mocks.handleOrchestratorDecision.mock.calls[0]
    expect(call[4]).toEqual({
      phase: 'alignment',
      phaseStep: 'pm_confirm',
      decisionTrace: '[{"step":"pm"}]',
    })
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('P2-07: 等锁期间会话被删除，拿锁后 404 且释放锁', async () => {
    let reads = 0
    mocks.sessionFindUnique.mockImplementation(async () => {
      reads += 1
      return reads === 1 ? session : null
    })
    let resolveLock!: (release: () => void) => void
    mocks.acquireSessionLock.mockReturnValueOnce(new Promise((resolve) => {
      resolveLock = resolve
    }))

    const pending = POST(makeReq({ message: 'hi' }), params)
    await waitUntil(() => mocks.acquireSessionLock.mock.calls.length > 0)
    resolveLock(mocks.releaseLock)

    const res = await pending
    await res.text()

    expect(res.status).toBe(404)
    expect(mocks.sessionFindUnique).toHaveBeenCalledTimes(2)
    expect(mocks.messageCreate).not.toHaveBeenCalled()
    expect(mocks.handleOrchestratorDecision).not.toHaveBeenCalled()
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('P2-07: 等锁期间被 stop 取消，重读后仍拒绝且不写消息', async () => {
    let resolveLock!: (release: () => void) => void
    mocks.acquireSessionLock.mockReturnValueOnce(new Promise((resolve) => {
      resolveLock = resolve
    }))

    const pending = POST(makeReq({ message: 'hi' }), params)
    await waitUntil(() => mocks.acquireSessionLock.mock.calls.length > 0)
    requestSessionCancel('s1')
    resolveLock(mocks.releaseLock)

    const res = await pending
    await res.text()

    expect(res.status).toBe(409)
    expect(mocks.messageCreate).not.toHaveBeenCalled()
    expect(mocks.handleOrchestratorDecision).not.toHaveBeenCalled()
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('P2-06: 客户端取消 body 后继续发事件不抛错、不中断后台，锁仍由 finally 释放', async () => {
    const gate = deferred<void>()
    const handlerDone = deferred<void>()
    let sentAfterCancel = false

    mocks.handleOrchestratorDecision.mockImplementationOnce(async (_message, _sessionId, _agents, sendEvent: (e: unknown) => void) => {
      try {
        sendEvent({ agentId: 'orchestrator', type: 'text', content: 'before-cancel' })
        await gate.promise
        sendEvent({ agentId: 'orchestrator', type: 'text', content: 'after-cancel' })
        sentAfterCancel = true
      } finally {
        handlerDone.resolve()
      }
    })

    const res = await POST(makeReq({ message: 'hi' }), params)
    const reader = res.body?.getReader()
    expect(reader).toBeDefined()
    const first = await reader!.read()
    expect(first.done).toBe(false)
    await reader!.cancel()

    gate.resolve()
    await handlerDone.promise
    await new Promise(r => setTimeout(r, 10))

    expect(sentAfterCancel).toBe(true)
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('P2-06: 客户端 cancel 会清理 SSE 超时定时器', async () => {
    vi.useFakeTimers()
    try {
      const gate = deferred<void>()
      const handlerDone = deferred<void>()
      mocks.handleOrchestratorDecision.mockImplementationOnce(async (_message, _sessionId, _agents, sendEvent: (e: unknown) => void) => {
        try {
          sendEvent({ agentId: 'orchestrator', type: 'text', content: 'before-cancel' })
          await gate.promise
        } finally {
          handlerDone.resolve()
        }
      })

      const res = await POST(makeReq({ message: 'hi' }), params)
      const reader = res.body?.getReader()
      expect(reader).toBeDefined()
      await reader!.read()
      expect(vi.getTimerCount()).toBe(1)

      await reader!.cancel()
      expect(vi.getTimerCount()).toBe(0)

      gate.resolve()
      await handlerDone.promise
    } finally {
      vi.useRealTimers()
    }
  })
})

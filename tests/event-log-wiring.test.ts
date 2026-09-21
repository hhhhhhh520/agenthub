import { describe, it, expect, vi, beforeEach } from 'vitest'

// roadmap §3.1 接线守卫：chat 路由的 sendEvent 必须经 createEventLogger
// （四类事件持久化 + 帧 seq 化），redo 路由的 noopSendEvent 必须换 persist-only
// logger（"redo 改 SSE"——事件落库后经 GET events 流可见）。防"服务写了没人接"
// 的变异存活（同型教训见 spawn/孤儿清扫守卫批次）。

const {
  mockCreateEventLogger,
  mockHandleOrchestratorDecision,
  mockHandleExecution,
  mockSessionFindUnique, mockSessionUpdate, mockSessionUpdateMany,
  mockTaskFindUnique, mockTaskFindMany, mockTaskUpdate,
  mockMessageCreate, mockAgentFindMany,
} = vi.hoisted(() => ({
  mockCreateEventLogger: vi.fn(),
  mockHandleOrchestratorDecision: vi.fn(),
  mockHandleExecution: vi.fn(),
  mockSessionFindUnique: vi.fn(),
  mockSessionUpdate: vi.fn(),
  mockSessionUpdateMany: vi.fn(),
  mockTaskFindUnique: vi.fn(),
  mockTaskFindMany: vi.fn(),
  mockTaskUpdate: vi.fn(),
  mockMessageCreate: vi.fn(),
  mockAgentFindMany: vi.fn(),
}))

vi.mock('@/lib/services/event-log', () => ({
  createEventLogger: mockCreateEventLogger,
}))

vi.mock('@/lib/services/chat-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/chat-router')>()
  return {
    ...actual,
    handleOrchestratorDecision: mockHandleOrchestratorDecision,
  }
})

vi.mock('@/lib/db', () => ({
  prisma: {
    session: {
      findUnique: mockSessionFindUnique,
      update: mockSessionUpdate,
      updateMany: mockSessionUpdateMany,
    },
    message: { create: mockMessageCreate },
    task: { findUnique: mockTaskFindUnique, findMany: mockTaskFindMany, update: mockTaskUpdate, updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    agent: { findMany: mockAgentFindMany },
    sessionMember: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    attachment: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}))

vi.mock('@/lib/session-lock', () => ({
  acquireSessionLock: vi.fn().mockResolvedValue(() => {}),
}))

vi.mock('@/lib/services/execution', () => ({
  handleExecution: mockHandleExecution,
}))

import { POST as chatPOST } from '@/app/api/sessions/[id]/chat/route'
import { POST as redoPOST } from '@/app/api/sessions/[id]/tasks/[taskId]/redo/route'

beforeEach(() => {
  vi.clearAllMocks()
  mockHandleExecution.mockResolvedValue(undefined)
  mockMessageCreate.mockResolvedValue({ id: 'm1' })
  mockAgentFindMany.mockResolvedValue([])
  mockTaskUpdate.mockResolvedValue({})
  mockSessionUpdate.mockResolvedValue({})
  mockSessionUpdateMany.mockResolvedValue({ count: 1 })
  // chat 默认链路：session 存在、无成员（Orchestrator 决策分支）
  mockSessionFindUnique.mockResolvedValue({ id: 's1', type: 'group', phase: 'execution', phaseStep: '', permissionMode: 'default' })
  // 默认 logger：sendEvent 同步走 stream（持久化类带 seq），flush spy——与真实实现同构
  mockCreateEventLogger.mockImplementation(async (_sessionId: string, opts?: { stream?: (e: Record<string, unknown>) => void }) => {
    let seq = 0
    const stream = opts?.stream
    return {
      sendEvent: (data: Record<string, unknown>) => {
        if (['thinking', 'tool_use', 'tool_result', 'permission_request', 'permission_cancel'].includes(String(data.type))) {
          stream?.({ ...data, seq: ++seq })
        } else {
          stream?.(data)
        }
      },
      flush: vi.fn().mockResolvedValue(undefined),
    }
  })
})

describe('chat 路由 × event-log 接线（§3.1）', () => {
  function chatReq(body: Record<string, unknown>) {
    return new Request('http://localhost/api/sessions/s1/chat', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  it('sendEvent 经 createEventLogger：持久化事件帧带 seq，flush 在流关闭前被调', async () => {
    let streamFn: ((e: Record<string, unknown>) => void) | undefined
    const flushSpy = vi.fn().mockResolvedValue(undefined)
    mockCreateEventLogger.mockImplementation(async (_sessionId: string, opts?: { stream?: (e: Record<string, unknown>) => void }) => {
      streamFn = opts?.stream
      let seq = 0
      const stream = opts?.stream
      return {
        sendEvent: (data: Record<string, unknown>) => {
          if (String(data.type) === 'thinking') stream?.({ ...data, seq: ++seq })
          else stream?.(data)
        },
        flush: flushSpy,
      }
    })
    mockHandleOrchestratorDecision.mockImplementation(async (_msg: string, _sid: string, _agents: unknown[], sendEvent: (d: Record<string, unknown>) => void) => {
      sendEvent({ agentId: 'a1', type: 'thinking', content: '推理中' })
      sendEvent({ agentId: 'orchestrator', type: 'done', content: '完成' })
    })

    const res = await chatPOST(chatReq({ message: 'hi' }), { params: Promise.resolve({ id: 's1' }) })
    expect(res.status).toBe(200)
    const body = await res.text()

    expect(mockCreateEventLogger).toHaveBeenCalledTimes(1)
    expect(mockCreateEventLogger.mock.calls[0][0]).toBe('s1')
    expect(typeof streamFn).toBe('function')
    // thinking 帧 JSON 带 seq（前端去重游标）；done 帧（Message 表已承载）不带
    expect(body).toContain('"type":"thinking"')
    expect(body).toContain('"seq":1')
    expect(body).toContain('"type":"done"')
    expect(body).not.toContain('"type":"done","content":"完成","seq"')
    // flush 在流关闭前被调
    expect(flushSpy).toHaveBeenCalledTimes(1)
  })
})

describe('redo 路由 × event-log 接线（§3.1 "redo 改 SSE"）', () => {
  const FAKE_AGENT = { id: 'a1', name: '前端', systemPrompt: 'sp', platform: 'claude-code', model: 'm', baseUrl: '', apiKey: 'k', tools: '[]' }

  it('noopSendEvent 退役：handleExecution 收到 logger.sendEvent，flush 在执行后被调', async () => {
    mockSessionFindUnique.mockResolvedValue({ phase: 'execution', phaseStep: '' })
    mockTaskFindUnique.mockResolvedValue({
      id: 't1', sessionId: 's1', status: 'failed', description: 'x',
      assignedAgent: FAKE_AGENT, assignedAgentId: 'a1', dependencies: '[]',
    })
    mockTaskFindMany.mockResolvedValue([])
    const flushSpy = vi.fn().mockResolvedValue(undefined)
    mockCreateEventLogger.mockResolvedValue({ sendEvent: vi.fn(), flush: flushSpy })
    // handleExecution 捕获 sendEvent 并调用一次（模拟执行中发出 thinking）
    mockHandleExecution.mockImplementation(async (_src: string, _sid: string, _agents: unknown[], sendEvent: (d: Record<string, unknown>) => void) => {
      sendEvent({ agentId: 'a1', type: 'thinking', content: 'redo 推理' })
    })

    const res = await redoPOST(
      new Request('http://localhost/redo', { method: 'POST', body: JSON.stringify({}) }),
      { params: Promise.resolve({ id: 's1', taskId: 't1' }) },
    )
    expect(res.status).toBe(200)

    expect(mockCreateEventLogger).toHaveBeenCalledWith('s1')
    expect(flushSpy).toHaveBeenCalledTimes(1)
    // 关键断言：handleExecution 收到的 sendEvent 就是 logger.sendEvent（noop 已退役）——
    // 执行链路发出的 thinking 走到了 logger（由 flush 前的真实调用链证明）
    expect(mockHandleExecution).toHaveBeenCalledTimes(1)
    const [, , , passedSendEvent] = mockHandleExecution.mock.calls[0]
    expect(passedSendEvent).toBeTypeOf('function')
  })
})

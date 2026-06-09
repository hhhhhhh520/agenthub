import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockTaskFindUnique, mockTaskUpdate, mockTaskFindMany,
  mockSessionFindUnique, mockMessageFindMany, mockMessageCreate,
  mockExecuteSingleAgent, mockAgentFindMany,
} = vi.hoisted(() => ({
  mockTaskFindUnique: vi.fn(),
  mockTaskUpdate: vi.fn(),
  mockTaskFindMany: vi.fn(),
  mockSessionFindUnique: vi.fn(),
  mockMessageFindMany: vi.fn().mockResolvedValue([]),
  mockMessageCreate: vi.fn(),
  mockExecuteSingleAgent: vi.fn(),
  mockAgentFindMany: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    task: { findUnique: mockTaskFindUnique, update: mockTaskUpdate, findMany: mockTaskFindMany },
    session: { findUnique: mockSessionFindUnique },
    message: { findMany: mockMessageFindMany, create: mockMessageCreate },
    agent: { findMany: mockAgentFindMany },
  },
}))

vi.mock('@/lib/orchestrator', () => ({
  executeSingleAgent: mockExecuteSingleAgent,
}))

vi.mock('@/lib/session-lock', () => ({
  acquireSessionLock: vi.fn().mockResolvedValue(() => {}),
}))

import { POST } from '@/app/api/sessions/[id]/tasks/[taskId]/redo/route'

function makeReq(body: Record<string, unknown> = {}) {
  return new Request('http://localhost/api/sessions/s1/tasks/t1/redo', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

const params = { params: Promise.resolve({ id: 's1', taskId: 't1' }) }

const FAKE_AGENT = {
  id: 'a1', name: '前端', systemPrompt: 'sp', platform: 'claude-code',
  model: 'm', baseUrl: '', apiKey: 'k', tools: '[]',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockMessageFindMany.mockResolvedValue([])
})

describe('POST /api/sessions/[id]/tasks/[taskId]/redo', () => {
  it('returns 404 when task not found', async () => {
    mockTaskFindUnique.mockResolvedValue(null)
    const res = await POST(makeReq(), params)
    expect(res.status).toBe(404)
  })

  it('returns 403 when task belongs to different session', async () => {
    mockTaskFindUnique.mockResolvedValue({
      id: 't1', sessionId: 'other-session', status: 'failed',
    })
    const res = await POST(makeReq(), params)
    expect(res.status).toBe(403)
  })

  it('returns 400 when task status is not redoable', async () => {
    mockTaskFindUnique.mockResolvedValue({
      id: 't1', sessionId: 's1', status: 'completed', assignedAgent: null,
    })
    const res = await POST(makeReq(), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Cannot redo')
  })

  it('resets failed task and executes successfully', async () => {
    mockTaskFindUnique.mockResolvedValue({
      id: 't1', sessionId: 's1', status: 'failed', description: '实现页面',
      assignedAgent: FAKE_AGENT, dependencies: '[]',
    })
    mockSessionFindUnique.mockResolvedValue({ id: 's1', projectDir: '', permissionMode: 'default' })
    mockTaskFindMany.mockResolvedValue([])
    mockExecuteSingleAgent.mockResolvedValue({ result: 'done', sessionId: 'cli-s1' })
    mockTaskUpdate.mockResolvedValue({})
    mockMessageCreate.mockResolvedValue({})

    const res = await POST(makeReq(), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('completed')
  })

  it('allows updating task description on redo', async () => {
    mockTaskFindUnique.mockResolvedValue({
      id: 't1', sessionId: 's1', status: 'blocked', description: '原始描述',
      assignedAgent: FAKE_AGENT, dependencies: '[]',
    })
    mockSessionFindUnique.mockResolvedValue({ id: 's1', projectDir: '', permissionMode: 'default' })
    mockTaskFindMany.mockResolvedValue([])
    mockExecuteSingleAgent.mockResolvedValue({ result: 'ok' })
    mockTaskUpdate.mockResolvedValue({})
    mockMessageCreate.mockResolvedValue({})

    await POST(makeReq({ description: '新描述' }), params)

    expect(mockTaskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ description: '新描述' }),
      })
    )
  })

  it('returns pending when no agent assigned', async () => {
    mockTaskFindUnique.mockResolvedValue({
      id: 't1', sessionId: 's1', status: 'failed', description: 'task',
      assignedAgent: null, dependencies: '[]',
    })
    mockTaskFindMany.mockResolvedValue([])

    const res = await POST(makeReq(), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('pending')
    expect(body.message).toContain('no agent assigned')
  })

  it('returns 500 when agent execution fails', async () => {
    mockTaskFindUnique.mockResolvedValue({
      id: 't1', sessionId: 's1', status: 'failed', description: 'task',
      assignedAgent: FAKE_AGENT, dependencies: '[]',
    })
    mockSessionFindUnique.mockResolvedValue({ id: 's1', projectDir: '', permissionMode: 'default' })
    mockTaskFindMany.mockResolvedValue([])
    mockExecuteSingleAgent.mockRejectedValue(new Error('Agent crashed'))

    const res = await POST(makeReq(), params)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.status).toBe('failed')
    expect(body.error).toContain('Agent crashed')
  })
})

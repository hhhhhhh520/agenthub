import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock prisma
const { mockTaskFindMany, mockTaskUpdate, mockTaskUpdateMany, mockSessionFindUnique, mockSessionUpdate, mockMessageFindMany, mockMessageCreate, mockSessionMemberFindMany, mockSessionMemberUpdateMany } = vi.hoisted(() => ({
  mockTaskFindMany: vi.fn(),
  mockTaskUpdate: vi.fn(),
  mockTaskUpdateMany: vi.fn(),
  mockSessionFindUnique: vi.fn(),
  mockSessionUpdate: vi.fn(),
  mockMessageFindMany: vi.fn(),
  mockMessageCreate: vi.fn(),
  mockSessionMemberFindMany: vi.fn(),
  mockSessionMemberUpdateMany: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    task: {
      findMany: mockTaskFindMany,
      update: mockTaskUpdate,
      updateMany: mockTaskUpdateMany,
    },
    session: {
      findUnique: mockSessionFindUnique,
      update: mockSessionUpdate,
    },
    message: {
      findMany: mockMessageFindMany,
      create: mockMessageCreate,
    },
    sessionMember: {
      findMany: mockSessionMemberFindMany,
      updateMany: mockSessionMemberUpdateMany,
    },
  },
}))

// Mock orchestrator
vi.mock('@/lib/orchestrator', () => ({
  executeTaskBatch: vi.fn(),
  callLLMForAnalysis: vi.fn(),
}))

// Mock orchestrator prompts
vi.mock('@/lib/orchestrator/prompts', () => ({
  buildMonitoringPrompt: vi.fn(),
}))

// Mock scheduler
vi.mock('@/lib/orchestrator/scheduler', () => ({
  enforceFileOverlap: vi.fn(),
}))

// Mock shadow-git
vi.mock('@/lib/services/shadow-git', () => ({
  getChangedFiles: vi.fn().mockReturnValue([]),
  getGitSnapshot: vi.fn().mockReturnValue(new Set()),
}))

// Mock context-builder
vi.mock('@/lib/services/context-builder', () => ({
  buildContextFromHistory: vi.fn().mockReturnValue(''),
}))

import { handleExecution } from '@/lib/services/execution'
import { executeTaskBatch, callLLMForAnalysis } from '@/lib/orchestrator'

describe('Execution Trace', () => {
  const mockSendEvent = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockMessageFindMany.mockResolvedValue([])
    mockMessageCreate.mockResolvedValue({})
    mockSessionUpdate.mockResolvedValue({})
    mockSessionFindUnique.mockResolvedValue({ projectDir: '', permissionMode: 'default' })
    mockSessionMemberFindMany.mockResolvedValue([])
    mockSessionMemberUpdateMany.mockResolvedValue({ count: 0 })
  })

  it('appends start trace when task begins execution', async () => {
    const tasks = [
      { id: 't1', description: 'task 1', status: 'pending', assignedAgentId: 'a1', sessionId: 's1', dependencies: '[]', declaredFiles: '[]', correctionCount: 0, trace: '[]', cliSessionId: null },
    ]
    mockTaskFindMany.mockResolvedValueOnce(tasks)
    mockTaskUpdate.mockResolvedValue({})
    ;(executeTaskBatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: new Map([['t1', { result: 'done', sessionId: 'cli-1' }]]),
      failedTaskIds: [],
    })

    await handleExecution('test message', 's1', [
      { id: 'a1', name: 'agent1', systemPrompt: '', platform: 'claude-code', expertise: '', model: '', baseUrl: '', apiKey: '', tools: '[]' },
    ], mockSendEvent)

    // Check that trace was updated with start event
    const startCall = mockTaskUpdate.mock.calls.find((call: any[]) => call[0].where.id === 't1' && call[0].data.status === 'in_progress')
    expect(startCall, 'should have an in_progress update for t1').toBeDefined()
    const startTrace = JSON.parse(startCall![0].data.trace)
    expect(startTrace).toHaveLength(1)
    expect(startTrace[0].event).toBe('start')
    expect(startTrace[0].agent).toBe('agent1')
    expect(startTrace[0].ts).toBeDefined()
    expect(typeof startTrace[0].ts).toBe('string')
  })

  it('appends success trace when task completes', async () => {
    const tasks = [
      { id: 't1', description: 'task 1', status: 'pending', assignedAgentId: 'a1', sessionId: 's1', dependencies: '[]', declaredFiles: '[]', correctionCount: 0, trace: '[]', cliSessionId: null },
    ]
    mockTaskFindMany.mockResolvedValueOnce(tasks)
    mockTaskUpdate.mockResolvedValue({})
    ;(executeTaskBatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: new Map([['t1', { result: 'done', sessionId: 'cli-1' }]]),
      failedTaskIds: [],
    })

    await handleExecution('test message', 's1', [
      { id: 'a1', name: 'agent1', systemPrompt: '', platform: 'claude-code', expertise: '', model: '', baseUrl: '', apiKey: '', tools: '[]' },
    ], mockSendEvent)

    // Check that trace was updated with success event
    const successCall = mockTaskUpdate.mock.calls.find((call: any[]) => call[0].where.id === 't1' && call[0].data.status === 'completed')
    expect(successCall, 'should have a completed update for t1').toBeDefined()
    const successTrace = JSON.parse(successCall![0].data.trace)
    const successEvent = successTrace.find((e: any) => e.event === 'success')
    expect(successEvent).toBeDefined()
    expect(successEvent.ts).toBeDefined()
    expect(successTrace.some((e: any) => e.event === 'start')).toBe(true) // start 事件也应该保留
  })

  it('appends error trace when task fails', async () => {
    const tasks = [
      { id: 't1', description: 'task 1', status: 'pending', assignedAgentId: 'a1', sessionId: 's1', dependencies: '[]', declaredFiles: '[]', correctionCount: 0, trace: '[]', cliSessionId: null },
    ]
    mockTaskFindMany.mockResolvedValueOnce(tasks)
    mockTaskUpdate.mockResolvedValue({})
    ;(executeTaskBatch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('API timeout'))

    await handleExecution('test message', 's1', [
      { id: 'a1', name: 'agent1', systemPrompt: '', platform: 'claude-code', expertise: '', model: '', baseUrl: '', apiKey: '', tools: '[]' },
    ], mockSendEvent)

    // Check that trace was updated with error event
    const failCall = mockTaskUpdate.mock.calls.find((call: any[]) => call[0].where.id === 't1' && call[0].data.status === 'failed')
    expect(failCall, 'should have a failed update for t1').toBeDefined()
    const failTrace = JSON.parse(failCall![0].data.trace)
    const errorEvent = failTrace.find((e: any) => e.event === 'error')
    expect(errorEvent).toBeDefined()
    expect(errorEvent.message).toBe('API timeout')
    expect(errorEvent.ts).toBeDefined()
  })

  it('appends blocked trace when dependency fails', async () => {
    const tasks = [
      { id: 't1', description: 'task 1', status: 'pending', assignedAgentId: 'a1', sessionId: 's1', dependencies: '[]', declaredFiles: '[]', correctionCount: 0, trace: '[]', cliSessionId: null },
      { id: 't2', description: 'task 2', status: 'pending', assignedAgentId: 'a1', sessionId: 's1', dependencies: '["t1"]', declaredFiles: '[]', correctionCount: 0, trace: '[]', cliSessionId: null },
    ]
    mockTaskFindMany.mockResolvedValueOnce(tasks)
    mockTaskUpdate.mockResolvedValue({})
    ;(executeTaskBatch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('failed'))

    await handleExecution('test message', 's1', [
      { id: 'a1', name: 'agent1', systemPrompt: '', platform: 'claude-code', expertise: '', model: '', baseUrl: '', apiKey: '', tools: '[]' },
    ], mockSendEvent)

    // Check that t2 was marked as blocked with trace
    const blockedCall = mockTaskUpdate.mock.calls.find((call: any[]) => call[0].where.id === 't2' && call[0].data.status === 'blocked')
    expect(blockedCall, 'should have a blocked update for t2').toBeDefined()
    const blockedTrace = JSON.parse(blockedCall![0].data.trace)
    const blockedEvent = blockedTrace.find((e: any) => e.event === 'blocked')
    expect(blockedEvent).toBeDefined()
    expect(blockedEvent.message).toBe('依赖任务失败')
  })
})

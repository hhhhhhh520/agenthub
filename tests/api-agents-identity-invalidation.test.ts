import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  invalidateAgentCliSessions: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    agent: {
      findUnique: mocks.findUnique,
      update: mocks.update,
    },
  },
}))

vi.mock('@/lib/services/cli-session', () => ({
  invalidateAgentCliSessions: mocks.invalidateAgentCliSessions,
}))

import { PUT } from '@/app/api/agents/[id]/route'

const params = { params: Promise.resolve({ id: 'a1' }) }

const request = (body: object) => new Request('http://localhost/api/agents/a1', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findUnique.mockResolvedValue({
    id: 'a1',
    name: '后端工程师',
    systemPrompt: '你负责 API',
    platform: 'claude-code',
  })
  mocks.update.mockResolvedValue({ id: 'a1', name: '后端工程师' })
  mocks.invalidateAgentCliSessions.mockResolvedValue(undefined)
})

describe('PUT /api/agents/[id] identity invalidation', () => {
  it('clears cli sessions when platform changes', async () => {
    const res = await PUT(request({ platform: 'opencode' }), params)

    expect(res.status).toBe(200)
    expect(mocks.invalidateAgentCliSessions).toHaveBeenCalledWith('a1')
  })

  it('clears cli sessions when role name or systemPrompt changes', async () => {
    await PUT(request({ name: '架构师' }), params)
    expect(mocks.invalidateAgentCliSessions).toHaveBeenCalledWith('a1')

    vi.clearAllMocks()
    mocks.findUnique.mockResolvedValue({
      id: 'a1', name: '后端工程师', systemPrompt: 'old', platform: 'opencode',
    })
    mocks.update.mockResolvedValue({ id: 'a1' })
    await PUT(request({ systemPrompt: 'new prompt' }), params)
    expect(mocks.invalidateAgentCliSessions).toHaveBeenCalledWith('a1')
  })

  it('does not clear cli sessions for model-only changes', async () => {
    await PUT(request({ model: 'claude-sonnet-4' }), params)

    expect(mocks.invalidateAgentCliSessions).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  sweep: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    agent: { findMany: mocks.findMany },
  },
}))

vi.mock('@/lib/services/claude-cfg-maintenance', () => ({
  sweepWithCurrentConfigs: mocks.sweep,
}))

import { GET, SELECTED_FIELDS } from '@/app/api/agents/route'
import { summarizeAgentPresence } from '@/lib/agent-presence'

function membership(status: string, id: string, title: string, updatedAt: string) {
  return { status, session: { id, title, updatedAt } }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.sweep.mockResolvedValue(undefined)
})

describe('summarizeAgentPresence', () => {
  it('prefers a working session over a newer idle session', () => {
    const summary = summarizeAgentPresence([
      membership('idle', 'newer', '更新的空闲会话', '2026-11-04T12:00:00.000Z'),
      membership('working', 'older', '正在执行的会话', '2026-11-01T12:00:00.000Z'),
    ])

    expect(summary.currentSession).toMatchObject({ id: 'older', status: 'working' })
    expect(summary.workingSessionCount).toBe(1)
    expect(summary.sessionCount).toBe(2)
  })

  it('uses the most recently updated session when nobody is working', () => {
    const summary = summarizeAgentPresence([
      membership('idle', 'old', '旧会话', '2026-10-01T12:00:00.000Z'),
      membership('done', 'new', '最近会话', '2026-11-04T12:00:00.000Z'),
    ])

    expect(summary.currentSession).toMatchObject({ id: 'new', status: 'done' })
    expect(summary.workingSessionCount).toBe(0)
  })

  it('returns an empty summary for an agent with no memberships', () => {
    expect(summarizeAgentPresence([])).toEqual({
      currentSession: null,
      workingSessionCount: 0,
      sessionCount: 0,
    })
  })
})

describe('GET /api/agents presence projection', () => {
  it('returns per-session presence and never reads deprecated Agent.status', async () => {
    mocks.findMany.mockResolvedValueOnce([
      {
        id: 'a1',
        name: '前端工程师',
        expertise: 'React',
        platform: 'claude-code',
        model: '',
        baseUrl: '',
        tools: '[]',
        isPreset: true,
        accentColor: '#6366f1',
        capabilities: '[]',
        memberships: [
          membership('idle', 's1', '旧会话', '2026-10-01T12:00:00.000Z'),
          membership('working', 's2', '当前会话', '2026-11-04T12:00:00.000Z'),
        ],
      },
      {
        id: 'a2',
        name: '后端工程师',
        expertise: 'Node',
        platform: 'opencode',
        model: '',
        baseUrl: '',
        tools: '[]',
        isPreset: true,
        accentColor: '#10b981',
        capabilities: '[]',
        memberships: [],
      },
    ])

    const res = await GET(new Request('http://localhost/api/agents'))
    const data = await res.json() as Array<Record<string, unknown>>

    expect(res.status).toBe(200)
    expect(SELECTED_FIELDS).not.toContain('status')
    expect(mocks.findMany.mock.calls[0][0].select.status).toBeUndefined()
    expect(mocks.findMany.mock.calls[0][0].select.memberships.select.status).toBe(true)
    expect(data[0]).not.toHaveProperty('status')
    expect(data[0]).toMatchObject({
      currentSession: { id: 's2', title: '当前会话', status: 'working' },
      workingSessionCount: 1,
      sessionCount: 2,
    })
    expect(data[1]).toMatchObject({
      currentSession: null,
      workingSessionCount: 0,
      sessionCount: 0,
    })
  })
})

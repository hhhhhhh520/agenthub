import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  memberUpdateMany: vi.fn(),
  taskUpdateMany: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    $transaction: mocks.transaction,
    sessionMember: { updateMany: mocks.memberUpdateMany },
    task: { updateMany: mocks.taskUpdateMany },
  },
}))

import { invalidateAgentCliSessions } from '@/lib/services/cli-session'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.memberUpdateMany.mockResolvedValue({ count: 2 })
  mocks.taskUpdateMany.mockResolvedValue({ count: 3 })
  mocks.transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops))
})

describe('invalidateAgentCliSessions', () => {
  it('clears both session members and tasks for the agent in one transaction', async () => {
    await invalidateAgentCliSessions('a1')

    expect(mocks.memberUpdateMany).toHaveBeenCalledWith({
      where: { agentId: 'a1' },
      data: { cliSessionId: null },
    })
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith({
      where: { assignedAgentId: 'a1' },
      data: { cliSessionId: null },
    })
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    expect(mocks.transaction.mock.calls[0][0]).toHaveLength(2)
  })
})

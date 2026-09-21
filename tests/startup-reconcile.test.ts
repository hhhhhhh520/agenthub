import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// §3.3 接线守卫：中断恢复 reconcile 必须在 app 启动时执行（src/instrumentation.ts
// register()）。防"函数写了没人调"的变异存活——同型教训见 spawn 守卫批次与 §2.3
// 孤儿清扫接线守卫（纯单测全绿但接线被删，全量仍绿）。

const { mockSessionFindMany, mockCleanupOrphan, mockReconcile } = vi.hoisted(() => ({
  mockSessionFindMany: vi.fn(),
  mockCleanupOrphan: vi.fn(),
  mockReconcile: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    session: { findMany: mockSessionFindMany },
  },
}))

vi.mock('@/lib/services/shadow-git', () => ({
  cleanupOrphanShadowGits: mockCleanupOrphan,
}))

vi.mock('@/lib/services/reconcile', () => ({
  reconcileInterruptedSessions: mockReconcile,
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  mockCleanupOrphan.mockReturnValue([])
  mockReconcile.mockResolvedValue(0)
  mockSessionFindMany.mockResolvedValue([])
})

afterEach(() => {
  delete process.env.NEXT_RUNTIME
})

describe('instrumentation.register — 启动时中断恢复接线（§3.3）', () => {
  it('nodejs runtime：register() 调用 reconcileInterruptedSessions（变异锚点：删接线必红）', async () => {
    process.env.NEXT_RUNTIME = 'nodejs'

    const { register } = await import('@/instrumentation')
    await register()

    expect(mockReconcile).toHaveBeenCalledTimes(1)
  })

  it('reconcile 抛错不阻塞启动（best-effort），孤儿清扫照常执行', async () => {
    process.env.NEXT_RUNTIME = 'nodejs'
    mockReconcile.mockRejectedValue(new Error('db not ready'))
    mockSessionFindMany.mockResolvedValue([{ id: 's1', projectDir: 'D:/proj-a' }])

    const { register } = await import('@/instrumentation')
    await expect(register()).resolves.toBeUndefined()

    expect(mockCleanupOrphan).toHaveBeenCalledWith('D:/proj-a', new Set(['s1']))
  })

  it('非 nodejs runtime（edge）直接返回，不调 reconcile', async () => {
    process.env.NEXT_RUNTIME = 'edge'

    const { register } = await import('@/instrumentation')
    await register()

    expect(mockReconcile).not.toHaveBeenCalled()
  })
})

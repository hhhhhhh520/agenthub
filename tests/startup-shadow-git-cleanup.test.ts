import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// roadmap §2.3 接线守卫：孤儿清扫必须在 app 启动时执行（src/instrumentation.ts
// register()）。防"函数写了没人调"的变异存活——同型教训见 spawn 守卫批次
// （纯单测全绿但接线被删，16 测试仍绿）。

const { mockSessionFindMany, mockCleanupOrphan } = vi.hoisted(() => ({
  mockSessionFindMany: vi.fn(),
  mockCleanupOrphan: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    session: { findMany: mockSessionFindMany },
  },
}))

vi.mock('@/lib/services/shadow-git', () => ({
  cleanupOrphanShadowGits: mockCleanupOrphan,
}))

// §3.3: reconcile 被 instrumentation 接线调用——本文件 mock 掉它（对齐 startup-reconcile.test.ts），
// 防真实模块在本文件残缺的 db mock（无 task 模型）上走异常路径（声明一致性审查建议）
vi.mock('@/lib/services/reconcile', () => ({
  reconcileInterruptedSessions: vi.fn().mockResolvedValue(0),
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  mockCleanupOrphan.mockReturnValue([])
})

afterEach(() => {
  delete process.env.NEXT_RUNTIME
})

describe('instrumentation.register — 启动时孤儿清扫接线', () => {
  it('nodejs runtime：按 distinct projectDir 扫描，validIds 为全库 session id 集合', async () => {
    process.env.NEXT_RUNTIME = 'nodejs'
    mockSessionFindMany.mockResolvedValue([
      { id: 's1', projectDir: 'D:/proj-a' },
      { id: 's2', projectDir: 'D:/proj-a' },
      { id: 's3', projectDir: 'D:/proj-b' },
      { id: 's4', projectDir: '' }, // projectDir 空（schema 默认值）→ 跳过
    ])

    const { register } = await import('@/instrumentation')
    await register()

    expect(mockSessionFindMany).toHaveBeenCalledWith({ select: { id: true, projectDir: true } })
    expect(mockCleanupOrphan).toHaveBeenCalledTimes(2)
    const [dirA, idsA] = mockCleanupOrphan.mock.calls.find(c => c[0] === 'D:/proj-a')!
    const [dirB, idsB] = mockCleanupOrphan.mock.calls.find(c => c[0] === 'D:/proj-b')!
    // validIds 是全库集合（目录名 = 全局唯一 sessionId，跨 projectDir 判孤儿）
    expect(new Set(idsA)).toEqual(new Set(['s1', 's2', 's3', 's4']))
    expect(new Set(idsB)).toEqual(new Set(['s1', 's2', 's3', 's4']))
    expect(dirA).toBe('D:/proj-a')
    expect(dirB).toBe('D:/proj-b')
  })

  it('非 nodejs runtime（edge）直接返回，不查 DB', async () => {
    process.env.NEXT_RUNTIME = 'edge'

    const { register } = await import('@/instrumentation')
    await register()

    expect(mockSessionFindMany).not.toHaveBeenCalled()
    expect(mockCleanupOrphan).not.toHaveBeenCalled()
  })

  it('DB 异常（如首次启动未 migrate）不冒泡，不阻塞启动', async () => {
    process.env.NEXT_RUNTIME = 'nodejs'
    mockSessionFindMany.mockRejectedValue(new Error('P1003: database does not exist'))

    const { register } = await import('@/instrumentation')
    await expect(register()).resolves.toBeUndefined()
    expect(mockCleanupOrphan).not.toHaveBeenCalled()
  })

  it('单 projectDir 清扫抛错不冒泡，其余 projectDir 继续清扫', async () => {
    process.env.NEXT_RUNTIME = 'nodejs'
    mockSessionFindMany.mockResolvedValue([
      { id: 's1', projectDir: 'D:/bad-dir' },
      { id: 's2', projectDir: 'D:/good-dir' },
    ])
    mockCleanupOrphan.mockImplementation((dir: string) => {
      if (dir === 'D:/bad-dir') throw new Error('EACCES')
      return ['orphan-1']
    })

    const { register } = await import('@/instrumentation')
    await expect(register()).resolves.toBeUndefined()
    expect(mockCleanupOrphan).toHaveBeenCalledWith('D:/good-dir', expect.any(Set))
  })
})

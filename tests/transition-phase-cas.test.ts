import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── §3.2 A1: transitionPhase 快照 CAS（roadmap "generation CAS 统一状态写入" phase 侧）──
//
// 竞态窗口（docs/design/phase2-3.2-write-points.md §2）：
//   session-lock.ts abort handler 在请求断开时提前 release 锁，而 handler 仍在后台跑
//   （chat/route.ts 传了 request.signal）——用户重发后新流与旧流（僵尸）并发：
//   两流各自 findUnique 读到旧 phase → 各自无条件 update → 后写覆盖先写（丢更新），
//   且先写方若已补记 trace（applied:true），trace 与 DB 永久不一致。
//
// CAS 语义（本文件锁定的行为契约）：
//   1. phase 写入必须是快照条件写：updateMany where { id, phase, phaseStep } = 读时快照
//   2. count=0（快照过期）→ 重读 → stateFromSession 重算转移：
//      新态下合法 → 用新快照重写（至多 3 次）；新态下非法 → fail-closed 拒写（可见 warn）
//   3. 重试超限 → fail-closed 放弃（ok:false），绝不无条件覆盖
//
// 变异验证锚点：把实现改回无条件 prisma.session.update → 本文件全部精确红。

const { mockSessionFindUnique, mockSessionUpdate, mockSessionUpdateMany } = vi.hoisted(() => ({
  mockSessionFindUnique: vi.fn(),
  mockSessionUpdate: vi.fn(),
  mockSessionUpdateMany: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    session: { findUnique: mockSessionFindUnique, update: mockSessionUpdate, updateMany: mockSessionUpdateMany },
  },
}))

import { transitionPhase } from '@/lib/orchestrator/state-machine'

/**
 * 带条件写语义的内存 DB：updateMany 的 where（除 id 外）逐字段匹配当前库值，全匹配才写入。
 * update 模拟现状的无条件写（变异对照用：新实现下不应被调用）。
 * trace CAS（where.decisionTrace）与 phase CAS（where.phase/phaseStep）共用本 mock。
 */
function makeDb(initial: { phase: string; phaseStep: string; decisionTrace?: string }) {
  const db: Record<string, string> = { decisionTrace: '[]', ...initial }
  mockSessionFindUnique.mockImplementation(async () => ({ ...db }))
  mockSessionUpdate.mockImplementation(async ({ data }: { data: Record<string, string> }) => {
    Object.assign(db, data)
    return {}
  })
  mockSessionUpdateMany.mockImplementation(async ({ where, data }: { where: Record<string, string>; data: Record<string, string> }) => {
    for (const [k, v] of Object.entries(where)) {
      if (k === 'id') continue
      if (db[k] !== v) return { count: 0 }
    }
    Object.assign(db, data)
    return { count: 1 }
  })
  return db
}

describe('transitionPhase 快照 CAS（§3.2 A1）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('并发交错：A 读后 B 流写入 align_pm，A(execute) 在新态下非法 → fail-closed 拒写，B 的转移不被覆盖', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = makeDb({ phase: 'idle', phaseStep: '' })
    let bWritten = false
    mockSessionFindUnique.mockImplementation(async () => {
      const snap = { ...db }
      if (!bWritten) {
        // 模拟 B 流（abort 释放锁窗口的并发请求）在 A 读完快照之后、写库之前完成自己的合法转移
        bWritten = true
        db.phase = 'alignment'
        db.phaseStep = 'pm_confirm'
      }
      return snap
    })

    // A 流基于过期快照 idle 提议 execute（idle+execute 表内合法）
    const r = await transitionPhase('s1', 'execute')

    // CAS：条件写发现快照过期 → 重读 align_pm → execute 非法 → fail-closed
    expect(r.ok).toBe(false)
    // B 的转移不被 A 覆盖（现状：A 无条件写 → db=execution，B 丢失 → 红）
    expect(db.phase).toBe('alignment')
    expect(db.phaseStep).toBe('pm_confirm')
    // 无条件写退出历史舞台（变异锚点：改回 update 必红）
    expect(mockSessionUpdate).not.toHaveBeenCalled()
    // fail-closed 可见
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('拒绝'))
    warnSpy.mockRestore()
  })

  it('并发交错：A 读后 B 流写入 align_pm，A(align_decompose) 在新态下仍合法 → 基于新快照条件写成功', async () => {
    const db = makeDb({ phase: 'idle', phaseStep: '' })
    let bWritten = false
    mockSessionFindUnique.mockImplementation(async () => {
      const snap = { ...db }
      if (!bWritten) {
        bWritten = true
        db.phase = 'alignment'
        db.phaseStep = 'pm_confirm'
      }
      return snap
    })

    // align_pm + align_decompose 表内合法（align_pm→align_arch）
    const r = await transitionPhase('s1', 'align_decompose')

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.nextState).toBe('align_arch')
    expect(db.phase).toBe('alignment')
    expect(db.phaseStep).toBe('architect_plan')
    expect(mockSessionUpdate).not.toHaveBeenCalled()
    // 全部 phase 形态的写入：第一次用 idle 快照（冲突 count=0），第二次必须用重读后的 align_pm 快照
    const phaseWrites = mockSessionUpdateMany.mock.calls.filter(c => c[0]?.where && 'phase' in c[0].where)
    expect(phaseWrites).toHaveLength(2)
    expect(phaseWrites[1][0].where).toMatchObject({ id: 's1', phase: 'alignment', phaseStep: 'pm_confirm' })
    expect(phaseWrites[1][0].data).toEqual({ phase: 'alignment', phaseStep: 'architect_plan' })
  })

  it('快照冲突重试超限（B 流持续介入）→ fail-closed 放弃，不无限重试不覆盖', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = makeDb({ phase: 'idle', phaseStep: '' })
    // phase 条件写永远冲突（B 流每次都在 A 重读后再次写入）
    mockSessionUpdateMany.mockImplementation(async ({ where }: { where: Record<string, string> }) => {
      if ('decisionTrace' in where) return { count: 1 } // trace CAS 正常（不受本场景影响）
      void db
      return { count: 0 }
    })

    const r = await transitionPhase('s1', 'align_confirm')

    expect(r.ok).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('重试超限'))
    // 重试上界：phase 条件写恰好尝试 TRANSITION_CAS_RETRIES(3) 次，不无限重试
    const phaseAttempts = mockSessionUpdateMany.mock.calls.filter(c => !('decisionTrace' in c[0].where))
    expect(phaseAttempts).toHaveLength(3)
    warnSpy.mockRestore()
  })

  it('无并发时行为不变：合法转移条件写一次成功（快照即当前值）', async () => {
    const db = makeDb({ phase: 'exec', phaseStep: '' })
    const r = await transitionPhase('s1', 'done')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.nextState).toBe('done')
    expect(db.phase).toBe('done')
    expect(mockSessionUpdate).not.toHaveBeenCalled()
  })
})

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createClient } from '@libsql/client'
import {
  analyzeSessions, gateHits, decideBranch, assertFailClosed, sanitizeExcerpt,
  prepareSnapshot, openGuardedReadonly, renderReport,
  type SessionRow, type TaskRow, type ReplayStats,
} from './analyze-port-replay'

const dec = (ts: string, state: string, action: string) => ({
  decisionPoint: 'handleOrchestratorDecision', corrections: [], ts,
  inputState: { phase: 'alignment', phaseStep: null, state },
  llmProposal: { action, reason: 'r' },
  validation: { passed: true, validator: 'applyTransition' },
  actualTransition: { from: state, to: state, action, applied: true, escalated: false },
})
const sess = (id: string, trace: string | null, updatedAt = '2026-08-05T00:00:00.000+00:00'): SessionRow =>
  ({ id, type: 'group', title: 'x', createdAt: '2026-08-01T00:00:00.000+00:00', updatedAt, decisionTrace: trace })
const task = (id: string, sessionId: string, createdAt: string): TaskRow => ({ id, sessionId, createdAt })

describe('analyzeSessions：谓词 + 决策时刻 taskCount（F10）', () => {
  it('idle+done 且任务晚于决策时刻 → 决策时刻 0（gate 命中）/终态 1 两列并存', () => {
    const st = analyzeSessions(
      [sess('g1', JSON.stringify([dec('2026-08-01T05:00:00Z', 'idle', 'done')]))],
      [task('tk1', 'g1', '2026-08-01T06:00:00.000+00:00')],
    )
    expect(st.hits.length).toBe(1)
    expect(st.hits[0].taskCountAtDecision).toBe(0)
    expect(st.hits[0].taskCountFinal).toBe(1)
    expect(st.analyzableSessions).toBe(1)
    expect(gateHits(st.hits).length).toBe(1)
  })
  it('决策时刻已有任务 → 非 gate 命中（事件仍记录）；非 idle 或非 done 不记', () => {
    const st = analyzeSessions(
      [sess('g1', JSON.stringify([
        dec('2026-08-01T05:00:00Z', 'idle', 'done'),
        dec('2026-08-01T05:30:00Z', 'exec', 'done'),
        dec('2026-08-01T05:40:00Z', 'idle', 'self'),
      ]))],
      [task('tk1', 'g1', '2026-08-01T04:00:00.000+00:00')],
    )
    expect(st.hits.length).toBe(1) // 只有 idle+done 入选
    expect(gateHits(st.hits).length).toBe(0) // 决策时刻 taskCount=1
  })
  it('p5-* 会话整体除名（实验数据非真实使用）', () => {
    const st = analyzeSessions([sess('p5-a1', JSON.stringify([dec('2026-08-01T05:00:00Z', 'idle', 'done')]))], [])
    expect(st.analyzableSessions).toBe(0)
    expect(st.hits.length).toBe(0)
  })
  it('坏 JSON / 非数组 → parseFailed；null/空数组 → traceEmpty（三态计数，F2）', () => {
    const st = analyzeSessions([sess('g1', '{bad'), sess('g2', '"scalar"'), sess('g3', null), sess('g4', '[]')], [])
    expect(st.parseFailed).toBe(2)
    expect(st.traceEmpty).toBe(2)
  })
  it('trace 触顶 500 → 除名不判命中，truncatedSessions 计数（F11 下界口径）', () => {
    const big = Array.from({ length: 500 }, () => dec('2026-08-01T05:00:00Z', 'idle', 'done'))
    const st = analyzeSessions([sess('g1', JSON.stringify(big))], [])
    expect(st.truncatedSessions).toBe(1)
    expect(st.hits.length).toBe(0)
    expect(st.analyzableSessions).toBe(1)
  })
  it('typeCounts/maxUpdatedAt 供报告元数据', () => {
    const st = analyzeSessions([sess('g1', '[]', '2026-08-06T00:00:00.000+00:00'), sess('g2', '[]')], [])
    expect(st.typeCounts.group).toBe(2)
    expect(st.maxUpdatedAt).toBe('2026-08-06T00:00:00.000+00:00')
  })
})

describe('decideBranch / assertFailClosed / sanitizeExcerpt', () => {
  it('analyzable<20 → branch 3；≥20 → manual（三分支规则）', () => {
    expect(decideBranch({ analyzableSessions: 19, gateHitCount: 0 }).branch).toBe('3')
    expect(decideBranch({ analyzableSessions: 20, gateHitCount: 5 }).branch).toBe('manual')
  })
  const base: ReplayStats = {
    scannedRows: 21, parseFailed: 0, tracePresent: 0, traceEmpty: 21, analyzableSessions: 0,
    truncatedSessions: 0, typeCounts: {}, hits: [], maxUpdatedAt: 'x',
    journalMode: 'delete', dbCopyPath: 'C:/abs/x.db', sha256: 'a'.repeat(64),
  }
  it('fail-closed：空库/解析失败/无 sha/相对路径都 throw（空壳库不得静默落分支3，F2）', () => {
    expect(() => assertFailClosed(base)).not.toThrow()
    expect(() => assertFailClosed({ ...base, scannedRows: 0 })).toThrow(/fail-closed/i)
    expect(() => assertFailClosed({ ...base, parseFailed: 2 })).toThrow(/fail-closed/i)
    expect(() => assertFailClosed({ ...base, sha256: '' })).toThrow(/fail-closed/i)
    expect(() => assertFailClosed({ ...base, dbCopyPath: 'rel/x.db' })).toThrow(/fail-closed/i)
  })
  it('sanitizeExcerpt：| 转义、控制符/双向覆盖剥离、80 码点截断（emoji 安全，F8）', () => {
    expect(sanitizeExcerpt('a|b\nc')).toBe('a\\|b c')
    expect(sanitizeExcerpt('x‮y')).toBe('x y')
    const emo = '😀'.repeat(85)
    const out = sanitizeExcerpt(emo)
    expect(Array.from(out).length).toBe(81) // 80 码点 + 截断标记「…」1
    expect(out).toBe('😀'.repeat(80) + '…')
  })
})

describe('prepareSnapshot / openGuardedReadonly（F1/F6 实证配方）', () => {
  it('源不存在 throw；wal 非空 throw；正常拷贝 sha256=64hex 且字节一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p10snap-'))
    expect(() => prepareSnapshot(join(dir, 'nope.db'), dir)).toThrow(/不存在/)
    writeFileSync(join(dir, 'dev.db'), 'dummy-bytes')
    writeFileSync(join(dir, 'dev.db-wal'), 'nonempty')
    expect(() => prepareSnapshot(join(dir, 'dev.db'), dir)).toThrow(/wal/)
    rmSync(join(dir, 'dev.db-wal'))
    const r = prepareSnapshot(join(dir, 'dev.db'), join(dir, 'out'))
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(r.sha256).toBe(createHash('sha256').update(readFileSync(join(dir, 'dev.db'))).digest('hex'))
    expect(existsSync(r.copyPath)).toBe(true)
  })
  it('openGuardedReadonly：query_only 拦真写；缺 Session 表 → 自测不通过即中止', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p10db-'))
    const p = join(dir, 't.db')
    const c = createClient({ url: 'file:' + p })
    await c.execute('CREATE TABLE Session (id TEXT PRIMARY KEY, phase TEXT)')
    await c.execute("INSERT INTO Session (id, phase) VALUES ('s1', 'idle')")
    c.close()
    const g = await openGuardedReadonly(p)
    await expect(g.execute("INSERT INTO Session (id) VALUES ('x')")).rejects.toThrow(/readonly/i)
    expect((await g.execute('SELECT id FROM Session')).rows.length).toBe(1) // 读仍可行
    g.close()
    const p2 = join(dir, 'empty.db')
    const c2 = createClient({ url: 'file:' + p2 })
    await c2.execute('SELECT 1')
    c2.close()
    await expect(openGuardedReadonly(p2)).rejects.toThrow(/write-self-test/)
  })
})

describe('renderReport', () => {
  it('含聚合行/分支/消毒摘录；决策与终态两列并示', () => {
    const st: ReplayStats = {
      scannedRows: 21, parseFailed: 0, tracePresent: 1, traceEmpty: 20, analyzableSessions: 4,
      truncatedSessions: 0, typeCounts: { group: 16 }, hits: [], maxUpdatedAt: '2026-08-05',
      journalMode: 'wal', dbCopyPath: 'C:/abs/snap/dev.db', sha256: 'b'.repeat(64),
    }
    const hits = [{ sessionId: 'g1', ts: 1, taskCountAtDecision: 0, taskCountFinal: 1 }]
    const md = renderReport(st, decideBranch({ analyzableSessions: 4, gateHitCount: 1 }), { g1: '帮我|做个东西\n谢谢' }, hits)
    expect(md).toContain('分支 **3**')
    expect(md).toContain('\\|')
    expect(md).toContain('决策时刻')
    expect(md).toContain('sha256')
  })
})

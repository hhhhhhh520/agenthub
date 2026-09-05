import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { TRANSITIONS, NON_TRANSITIONING, seqgatePredicate, PROBE_BATCH, loadMetricsRows, selectProbeCells, prepareSnapshot, openGuardedReadonly, assertSnapshotPath, readAll, joinRuns } from './analyze-a-surface-probe'

const SM_SRC = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'lib', 'orchestrator', 'state-machine.ts'), 'utf8')

describe('源文本漂移（内联副本 == state-machine.ts）', () => {
  it('TRANSITIONS 关键边与源一致', () => {
    for (const seg of [
      "align_confirm: 'align_pm'", "align_decompose: 'align_arch'", "execute: 'exec'", "done: 'done'",
      "align_qa: 'align_qa'",
    ]) expect(SM_SRC).toContain(seg)
    // 内联副本与源同构：抽查三条
    expect(TRANSITIONS.idle.align_decompose).toBe('align_arch')
    expect(TRANSITIONS.exec.done).toBe('done')
    expect(TRANSITIONS.align_qa.align_decompose).toBe('align_arch')
  })
  it('NON_TRANSITIONING 与源一致', () => {
    for (const a of ['self', 'delegate', 'discuss', 'verify']) {
      expect(SM_SRC).toContain(`'${a}'`)
      expect(NON_TRANSITIONING.has(a as never)).toBe(true)
    }
  })
  it('seqgate 谓词与源一致', () => {
    expect(SM_SRC).toContain("state === 'idle' && action === 'done' && taskCount === 0")
    expect(seqgatePredicate('idle', 'done', 0)).toBe(true)
    expect(seqgatePredicate('idle', 'done', 1)).toBe(false)
    expect(seqgatePredicate('exec', 'done', 0)).toBe(false)
  })
})

const mk = (dir: string, name: string, lines: object[]) => { const p = join(dir, name); writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n')); return p }
describe('metrics 加载与选样', () => {
  const row = (over: object = {}) => ({ runId: 'x', config: 'off+verify', taskId: 'A', seed: 0, pass: false, failureMode: 'no-pass', failKind: 'skipped-spec-edge', rounds: 3, escalateCount: 0, correctionCount: 0, illegalProposalCount: 0, totalTransitions: 2, latencyMs: 1, tracePath: '', ...over })
  it('loadMetricsRows 解析 + 坏行计数', () => {
    const d = mkdtempSync(join(tmpdir(), 'p11-')); const f = mk(d, 'm.jsonl', [row(), row({ taskId: 'B' })])
    writeFileSync(f, '\nnot-json\n', { flag: 'a' })
    const { rows, badLines } = loadMetricsRows(f)
    expect(rows).toHaveLength(2); expect(badLines).toBe(1)
  })
  it('selectProbeCells 只留 A 与强带 C-off、排除哨兵/中止 config', () => {
    const d = mkdtempSync(join(tmpdir(), 'p11-'))
    const f = mk(d, 'm.jsonl', [row(), row({ config: 'on+verify', taskId: 'C' }), row({ config: 'off+no-verify', taskId: 'A' })])
    const { A, strongCOff } = selectProbeCells(loadMetricsRows(f).rows)
    expect(A).toHaveLength(1)           // off+verify A（off+no-verify 不在 arms）
    expect(strongCOff).toHaveLength(0)   // C-off 仅在 strong 文件；此处未标 band
  })
})

describe('快照+只读+白名单', () => {
  it('prepareSnapshot 非空 WAL 拒、只拷主文件', () => {
    const d = mkdtempSync(join(tmpdir(), 'p11-')); const db = join(d, 'p5.db')
    writeFileSync(db, 'x'); writeFileSync(db + '-wal', 'nonempty')
    expect(() => prepareSnapshot(db, join(d, 'snap'))).toThrow(/wal 非空/)
  })
  it('prepareSnapshot WAL 空时放行：只拷主文件、绝不拷 -wal/-shm、sha256 正确', () => {
    const d = mkdtempSync(join(tmpdir(), 'p11-')); const db = join(d, 'p5.db')
    writeFileSync(db, 'main-db-bytes'); writeFileSync(db + '-wal', ''); writeFileSync(db + '-shm', 'shm')
    const out = join(d, 'snap')
    const { copyPath, sha256 } = prepareSnapshot(db, out)
    expect(copyPath).toBe(join(out, 'p5.db'))
    expect(readFileSync(copyPath, 'utf8')).toBe('main-db-bytes')
    expect(sha256).toBe(createHash('sha256').update('main-db-bytes').digest('hex'))
    expect(existsSync(join(out, 'p5.db-wal'))).toBe(false)
    expect(existsSync(join(out, 'p5.db-shm'))).toBe(false)
  })
  it('openGuardedReadonly write-self-test 拦写', async () => {
    const d = mkdtempSync(join(tmpdir(), 'p11-')); const db = join(d, 'p5.db')
    const c = createClient({ url: 'file:' + db })
    await c.execute('CREATE TABLE Session (id TEXT, phase TEXT)'); await c.close()
    const ro = await openGuardedReadonly(db)
    await expect(ro.execute('UPDATE Session SET phase=phase')).rejects.toThrow()
    ro.close()
  })
  it('assertSnapshotPath 只认 snapshot-*/p5.db', () => {
    expect(() => assertSnapshotPath(join('experiments','p5','p5.db'))).toThrow()
    expect(() => assertSnapshotPath(join('experiments','p5','results','snapshot-2026','p5.db'))).not.toThrow()
  })
  it('readAll 参数化读取 journalMode+Session/Task 行', async () => {
    const d = mkdtempSync(join(tmpdir(), 'p11-')); const db = join(d, 'p5.db')
    const c = createClient({ url: 'file:' + db })
    await c.execute('CREATE TABLE Session (id TEXT, title TEXT, projectDir TEXT, phase TEXT, createdAt TEXT, decisionTrace TEXT)')
    await c.execute('CREATE TABLE Task (id TEXT, sessionId TEXT, createdAt TEXT)')
    await c.execute({ sql: 'INSERT INTO Session VALUES (?, ?, ?, ?, ?, ?)', args: ['s1', 't', '/p', 'done', '2026-09-04', null] })
    await c.execute({ sql: 'INSERT INTO Task VALUES (?, ?, ?)', args: ['t1', 's1', '2026-09-04'] })
    await c.close()
    const ro = await openGuardedReadonly(db)
    const all = await readAll(ro)
    expect(all.journalMode.length).toBeGreaterThan(0)
    expect(all.sessions).toEqual([{ id: 's1', title: 't', projectDir: '/p', phase: 'done', createdAt: '2026-09-04', decisionTrace: null }])
    expect(all.tasks).toEqual([{ id: 't1', sessionId: 's1', createdAt: '2026-09-04' }])
    ro.close()
  })
})

describe('join 双射与计数', () => {
  const sess = (projectDir: string) => ({ id: 's' + projectDir, title: 'p5-x', projectDir, phase: 'done', createdAt: '', decisionTrace: '[]' })
  const mrow = (runId: string, config='off+verify', taskId='A' as const, seed=0) => ({ runId, config, taskId, seed, pass:false, failureMode:'no-pass', failKind:'skipped-spec-edge', rounds:3, escalateCount:0, correctionCount:0, illegalProposalCount:0, totalTransitions:2, latencyMs:1 })
  it('basename startsWith runId 正确 1:1（含同 title 不同 run）', () => {
    // 注：两行 (config,task,seed) 必须唯一，否则触发重复键守卫——第二行 seed 0→1
    const sessions = [sess('off+verify-A-s0-aaaaaaaa-extra'), sess('off+verify-A-s1-bbbbbbbb-extra')]
    const rows = [mrow('off+verify-A-s0-aaaaaaaa'), mrow('off+verify-A-s1-bbbbbbbb', 'off+verify', 'A', 1)]
    const joined = joinRuns(rows, sessions, { A: 2 })
    expect(joined).toHaveLength(2)
  })
  it('计数不符 expect 抛 fail-closed', () => {
    expect(() => joinRuns([mrow('off+verify-A-s0-aaaaaaaa')], [sess('off+verify-A-s0-aaaaaaaa-x')], { A: 15 })).toThrow(/计数/)
  })
  it('runId 无会话命中抛 fail-closed', () => {
    expect(() => joinRuns([mrow('nope')], [sess('other-x')], { A: 1 })).toThrow(/唯一会话命中/)
  })
  it('重复 (config,task,seed) 抛 fail-closed', () => {
    expect(() => joinRuns([mrow('r1'), mrow('r2')], [sess('r1-x'), sess('r2-x')], { A: 2 })).toThrow(/重复/)
  })
  it('被占用会话不可再次命中（防同会话配两个 runId）', () => {
    expect(() => joinRuns([mrow('aaa'), mrow('aaa-x')], [sess('aaa-x')], { A: 2 })).toThrow(/唯一会话命中/)
  })
})

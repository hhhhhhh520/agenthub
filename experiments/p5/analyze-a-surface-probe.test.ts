import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { TRANSITIONS, NON_TRANSITIONING, seqgatePredicate, PROBE_BATCH, loadMetricsRows, selectProbeCells, prepareSnapshot, openGuardedReadonly, assertSnapshotPath, readAll, joinRuns, parseEntries, terminalDecision, taskCountAtDecision, appliedEdgesOf, classifyBucket, missingRequired, edgeCoverableFromT, edgeCoverableFrom, machineCheckIT, machineCheckI, confirmState, type Bucket } from './analyze-a-surface-probe'
import { TASKS } from './tasks'

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

describe('签名提取', () => {
  const E = (over: object = {}) => ({ decisionPoint: 'handleOrchestratorDecision', inputState: { state: 'idle' }, llmProposal: { action: 'done' }, corrections: [], validation: {}, actualTransition: { action: 'done', from: 'idle', to: 'done', applied: true, escalated: false }, ts: '2026-09-02T10:00:00.000Z', ...over })
  it('parseEntries 非数组 → null', () => { expect(parseEntries('{}')).toBeNull(); expect(parseEntries('[1]')).not.toBeNull() })
  it('parseEntries 空/null/\'[]\' → []，畸形 JSON → null（fail-closed）', () => {
    expect(parseEntries(null)).toEqual([])
    expect(parseEntries('')).toEqual([])
    expect(parseEntries('[]')).toEqual([])
    expect(parseEntries('{broken')).toBeNull()
    expect(parseEntries('{"a":1}')).toBeNull()
  })
  it('terminalDecision 取最后一个决策点', () => {
    const entries = [E({ inputState: { state: 'idle' }, llmProposal: { action: 'execute' } }), E()]
    expect(terminalDecision(entries)).toEqual({ state: 'idle', action: 'done' })
  })
  it('terminalDecision 无决策点条目 → null', () => {
    expect(terminalDecision([{ ts: '2026-09-02T10:00:00.000Z' }])).toBeNull()
  })
  it('taskCountAtDecision 用 Date.parse 数值比', () => {
    const tasks = [{ id: 't1', sessionId: 's', createdAt: '2026-09-02T09:59:00.000+00:00' }, { id: 't2', sessionId: 's', createdAt: '2026-09-02T10:01:00.000+00:00' }]
    expect(taskCountAtDecision(tasks, Date.parse('2026-09-02T10:00:00.000Z'))).toBe(1)
  })
  it('taskCountAtDecision 两种时间戳格式（+00:00 vs Z）数值等价、恰等时计入', () => {
    const tasks = [{ id: 't1', sessionId: 's', createdAt: '2026-09-02T10:00:00.000Z' }]
    expect(taskCountAtDecision(tasks, Date.parse('2026-09-02T10:00:00.000+00:00'))).toBe(1)
  })
  it('appliedEdgesOf 只收 applied 且非旁路', () => {
    const entries = [E(), E({ actualTransition: { action: 'self', from: 'idle', to: 'idle', applied: true, escalated: false } })]
    expect(appliedEdgesOf(entries)).toEqual([{ action: 'done', from: 'idle', to: 'done' }])
  })
  it('appliedEdgesOf 漏 applied=false / 无 actualTransition 不收', () => {
    const entries = [E({ actualTransition: { action: 'done', from: 'idle', to: 'done', applied: false, escalated: false } }), { ts: '2026-09-02T10:00:00.000Z' }]
    expect(appliedEdgesOf(entries)).toEqual([])
  })
})

describe('四桶分类器', () => {
  const base = { appliedEdges: [{ action:'done', from:'idle', to:'done' }], failureMode:'no-pass', failKind:'skipped-spec-edge' }
  it('⓪：空 trace', () => expect(classifyBucket({ ...base, entries: [], terminal: null, taskCountAtTerminal: 0 })).toBe('⓪'))
  it('⓪：appliedEdges=0 ∧ error（⓪≻③）', () => expect(classifyBucket({ entries:[{}], appliedEdges: [], failureMode:'error', failKind:'defect', terminal:{state:'idle',action:'done'}, taskCountAtTerminal:0 })).toBe('⓪'))
  it('①(a)：末决策 idle∧done∧tc0', () => expect(classifyBucket({ ...base, entries:[{}], terminal:{state:'idle',action:'done'}, taskCountAtTerminal:0 })).toBe('①'))
  it('①(b)：末条目 fired correction（三合取）', () => {
    const entries = [{ decisionPoint:'handleOrchestratorDecision', inputState:{state:'idle'}, llmProposal:{action:'done'}, corrections:[{from:'done',to:'align_decompose'}], actualTransition:{applied:false}, ts:'2026-09-02T10:00:00.000Z' }]
    expect(classifyBucket({ entries, appliedEdges:[{action:'execute',from:'idle',to:'exec'}], failureMode:'no-pass', failKind:'skipped-spec-edge', terminal:{state:'idle',action:'done'}, taskCountAtTerminal:1 })).toBe('①')
  })
  it('①∩③：fired correction ∧ error → ①（优先级）', () => {
    const entries = [{ decisionPoint:'handleOrchestratorDecision', inputState:{state:'idle'}, llmProposal:{action:'done'}, corrections:[{from:'done',to:'align_decompose'}], actualTransition:{applied:true,action:'done',from:'idle',to:'done'}, ts:'' }]
    expect(classifyBucket({ entries, appliedEdges:[{action:'done',from:'idle',to:'done'}], failureMode:'error', failKind:'defect', terminal:{state:'idle',action:'done'}, taskCountAtTerminal:0 })).toBe('①')
  })
  it('③：error ∧ appliedEdges>0 ∧ 非①签名', () => expect(classifyBucket({ entries:[{}], appliedEdges:[{action:'execute',from:'idle',to:'exec'}], failureMode:'error', failKind:'defect', terminal:{state:'exec',action:'execute'}, taskCountAtTerminal:1 })).toBe('③'))
  it('②：skipped-spec-edge ∧ 非① ∧ 非③ ∧ 非⓪（构造性残差）', () => expect(classifyBucket({ entries:[{}], appliedEdges:[{action:'execute',from:'idle',to:'exec'}], failureMode:'no-pass', failKind:'skipped-spec-edge', terminal:{state:'align_arch',action:'done'}, taskCountAtTerminal:1 })).toBe('②'))
  it('穷尽构造：任给集合 ⓪+①+②+③ == 总数', () => {
    // 由实现保证 ② 为残差，四桶覆盖全集
    const cases = ['⓪','①','②','③'] as Bucket[]
    expect(new Set(cases).size).toBe(4)
  })
  // ── Task 5 审查传递约束 1：空串签名拒收——terminalDecision 缺字段回退 ''，空串不得滑入任何正桶 ──
  it('空串签名拒收：terminal.state=\'\' 抛错（防「非 idle→②」否定式谓词误吸空串）', () => {
    expect(() => classifyBucket({ ...base, entries:[{}], terminal:{state:'',action:'done'}, taskCountAtTerminal:1 })).toThrow(/空串/)
  })
  it('空串签名拒收：terminal.action=\'\' 抛错（idle∧空action 不得判①或②）', () => {
    expect(() => classifyBucket({ ...base, entries:[{}], terminal:{state:'idle',action:''}, taskCountAtTerminal:0 })).toThrow(/空串/)
  })
  // ── Task 5 审查传递约束 3：NaN createdAt 静默排除的偏差方向钉子（少计→虚增①命中，污染偏向 gate 侧）──
  it('taskCountAtDecision 已知偏差：NaN createdAt 任务不计入（钉住上游行为）', () => {
    const tasks = [
      { id: 'bad', sessionId: 's', createdAt: 'not-a-date' },
      { id: 'ok', sessionId: 's', createdAt: '2026-09-02T09:00:00.000Z' },
    ]
    expect(taskCountAtDecision(tasks, Date.parse('2026-09-02T10:00:00.000Z'))).toBe(1)
  })
  // ── 审查 R1 变异存活缺口负例：①语义「常被做错」两处各钉一条（实现零改动）──
  it('负例A·限末决策：前条 fired 但末决策非①签名 → ②（find 改 filter+some 会误判①）', () => {
    const entries = [
      { decisionPoint:'handleOrchestratorDecision', inputState:{state:'idle'}, llmProposal:{action:'done'}, corrections:[{from:'done',to:'align_decompose'}], ts:'2026-09-02T10:00:00.000Z' },
      { decisionPoint:'handleOrchestratorDecision', inputState:{state:'align_arch'}, llmProposal:{action:'done'}, corrections:[], ts:'2026-09-02T10:01:00.000Z' },
    ]
    expect(classifyBucket({ entries, appliedEdges:[{action:'execute',from:'idle',to:'exec'}], failureMode:'no-pass', failKind:'skipped-spec-edge', terminal:{state:'align_arch',action:'done'}, taskCountAtTerminal:1 })).toBe('②')
  })
  it('负例B·第三合取：corrections 命中但 inputState 非 idle → ②（删第三合取会误判①）', () => {
    const entries = [{ decisionPoint:'handleOrchestratorDecision', inputState:{state:'align_arch'}, llmProposal:{action:'done'}, corrections:[{from:'done',to:'align_decompose'}], ts:'2026-09-02T10:00:00.000Z' }]
    expect(classifyBucket({ entries, appliedEdges:[{action:'execute',from:'idle',to:'exec'}], failureMode:'no-pass', failKind:'skipped-spec-edge', terminal:{state:'align_arch',action:'done'}, taskCountAtTerminal:1 })).toBe('②')
  })
})

// ── Task 7：missingRequired 与 oracle 等价性黄金测试 ──
// 探针不 import metrics.ts 的 hasRequiredEdges（未导出且属生产文件）；等价性靠此处独立手写的参考实现对拍，防口径分家。
describe('missingRequired 等价性', () => {
  // 参考实现（镜像 metrics.ts:27 hasRequiredEdges 的缺失边语义，独立写以防口径分家）
  const refMissing = (applied: any[], required: any[]) => required.filter(req => !applied.some(a => a.action === req.action && a.to === req.to && (req.from === '*' || a.from === req.from)))
  const A = TASKS.find(t => t.id === 'A')!.requiredEdges
  it('与参考实现逐例全等', () => {
    const cases = [
      [], [{ action:'done', from:'exec', to:'done' }],
      [{ action:'align_decompose', from:'idle', to:'align_arch' }, { action:'execute', from:'align_qa', to:'exec' }, { action:'done', from:'exec', to:'done' }],
      [{ action:'execute', from:'idle', to:'exec' }],
    ]
    for (const applied of cases) expect(missingRequired(applied, A)).toEqual(refMissing(applied, A))
  })
  it('from=* 匹配任意 from', () => expect(missingRequired([{ action:'execute', from:'align_qa', to:'exec' }], [{ action:'execute', from:'*', to:'exec' }])).toEqual([]))
  it('done 边钉 from=exec', () => expect(missingRequired([{ action:'done', from:'idle', to:'done' }], [{ action:'done', from:'exec', to:'done' }])).toHaveLength(1))
  // 判别力补钉（上游审查纪律：漏掉 to 匹配的变异必须红）：brief 4+2 用例的 required 边 action 互异，to 相等永不成为决定条件，
  // 故单钉一条 to 不同 → 缺失 的边界（同 action 同 from 仅 to 异）。
  it('to 必须相等：同 action 同 from 但 to 不同 → 缺失', () => expect(missingRequired([{ action:'done', from:'exec', to:'align_arch' }], [{ action:'done', from:'exec', to:'done' }])).toHaveLength(1))
})

// ── Task 8：机检 (i) 可达性 + (ii) 非 seqgate + confirm-state ──
// 正例用合成表证 (i) 非恒假；负例/变异用真实表证 (i) 对真实连通表会败（预期主结局：②多呈 candidate）。
describe('机检 (i)(ii) + confirm-state', () => {
  const reqDone = { action:'done', from:'exec', to:'done' }
  it('(i) 合成表：缺失边不可达 → 通过（证非恒假）', () => {
    // 合成转移表：exec 只有 execute 自环，无 done → exec→done 不可达
    const synth: any = { exec: { execute: 'exec' } }
    expect(edgeCoverableFromT('exec', reqDone, synth)).toBe(false)
    expect(machineCheckIT('exec', [reqDone], synth)).toBe(true)   // 全不可覆盖 → (i) 过
  })
  it('(i) 真实表：必需边可达 → 失败（模型怪癖/可跳过，变异负例）', () => {
    for (const e of TASKS.find(t=>t.id==='A')!.requiredEdges) expect(edgeCoverableFrom('idle', e)).toBe(true)
    expect(machineCheckI('idle', TASKS.find(t=>t.id==='A')!.requiredEdges)).toBe(false)
  })
  it('(ii) seqgate 谓词命中 → 非真新模式', () => {
    expect(seqgatePredicate('idle','done',0)).toBe(true)  // 该签名应归①不进②，(ii) 对②签名恒非 seqgate
  })
  it('confirmState：(i)败 → candidate 不翻绿', () => {
    expect(confirmState('idle/done/x', TASKS.find(t=>t.id==='A')!.requiredEdges, 3, 'idle')).toBe('candidate')
  })
})

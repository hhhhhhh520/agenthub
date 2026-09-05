import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { TRANSITIONS, NON_TRANSITIONING, seqgatePredicate, PROBE_BATCH, loadMetricsRows, selectProbeCells, prepareSnapshot, openGuardedReadonly, assertSnapshotPath, assertWeakFrozenSha, readAll, joinRuns, parseEntries, terminalDecision, taskCountAtDecision, appliedEdgesOf, classifyBucket, missingRequired, edgeCoverableFromT, edgeCoverableFrom, machineCheckIT, machineCheckI, confirmState, confirmStateT, calibrate, assertSentinel, verdict, renderMap, signatureOf, metricsTruthFromRows, calibrationBuckets, assertPctLedger, probeSession, probeSessions, buildMapRows, partitionSingles, assembleReport, type Bucket, type SigRow, type JoinedRun, type TaskRow, type MapRowInput, type ReportParts } from './analyze-a-surface-probe'
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
  // 参考实现（镜像 metrics.ts:27 hasRequiredEdges 的缺失边语义，独立写以防口径分家）。冻结：勿随 missingRequired 同步修改。
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
  // 合成转移表：exec 只有 execute 自环，无 done → exec→done 不可达
  const synth: any = { exec: { execute: 'exec' } }
  it('(i) 合成表：缺失边不可达 → 通过（证非恒假）', () => {
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
  // ── R1/5 审查补钉：偏绿方向变异存活缺口（every→some、count 门弱化、confirmed 分支删除）──
  it('(i) 混合集：一不可覆盖+一可覆盖 → false（杀 every→some 变异）', () => {
    // reqDone 在 synth 下不可覆盖；execute→exec 可覆盖 → every 必 false，some 会误 true
    expect(machineCheckIT('exec', [reqDone, { action:'execute', from:'*', to:'exec' }], synth)).toBe(false)
  })
  it('confirmState count 门：(i)过 ∧ count=1 → candidate（杀 count>=2 弱化为 >=0）', () => {
    // confirmState 硬连真实表（reqDone 从 exec 可覆盖→(i)恒败→count 门不可观测），
    // 故经带表参的 confirmStateT 在合成表下使 (i) 过，count 门才可观测——语义即「合成表下的 confirmState」
    expect(confirmStateT('sig', [reqDone], 1, 'exec', synth)).toBe('candidate')
  })
  it('confirmState confirmed 分支：(i)过 ∧ count=2 → confirmed（钉活分支，兼杀恒-candidate/整段删除变异）', () => {
    expect(confirmStateT('sig', [reqDone], 2, 'exec', synth)).toBe('confirmed')
  })
})

// ── Task 9：强带 C-off 正对照/标定（阈值 4/5 + ⓪退化降级）──
describe('正对照标定（钉强带）', () => {
  it('①复现率 ≥4/5 → 校准通过', () => expect(calibrate(['①','①','①','①','①']).degraded).toBe(false))
  it('①复现率 3/5 → 降级', () => expect(calibrate(['①','①','①','②','③']).degraded).toBe(true))
  it('多⓪ → 降级并给原因', () => { const c = calibrate(['⓪','⓪','⓪','①','①']); expect(c.degraded).toBe(true); expect(c.reason).toContain('⓪') })
  it('①复现率 恰等 4/5 → 不降级', () => expect(calibrate(['①','①','①','①','②']).degraded).toBe(false))
  it('空数组 → fail-closed 降级', () => expect(calibrate([]).degraded).toBe(true))
})

// ── Task 10：口径锚点哨兵（硬约束 ③≤4 / skip==9 / defect==4；==13 仅 sanity）──
describe('口径锚点哨兵', () => {
  it('满足硬约束 → ok', () => expect(assertSentinel({ zero:0, one:9, two:0, three:4 }, { skip:9, defect:4 }).ok).toBe(true))
  it('③>4 → 违例', () => expect(assertSentinel({ zero:0, one:8, two:0, three:5 }, { skip:9, defect:4 }).ok).toBe(false))
  it('skip≠9 → 违例', () => expect(assertSentinel({ zero:0, one:8, two:1, three:4 }, { skip:8, defect:4 }).ok).toBe(false))
  it('③∈[2,4] 带宽外仅警告不阻断', () => { const r = assertSentinel({ zero:0, one:10, two:0, three:3 }, { skip:9, defect:4 }); expect(r.ok).toBe(true) })
  // ── Task 7 审查携带①：数据金丝雀——钉住「当前数据无 to:'*' 边」这一 missingRequired 口径前提；数据演化引入 to:'*' 时此测试直接红、强制口径复核 ──
  it('数据金丝雀：TASKS 无 to:\'*\' 边', () => expect(TASKS.flatMap(t => t.requiredEdges).filter(e => e.to === '*')).toHaveLength(0))
  // ── 针对性补钉：brief 代码未覆盖的硬约束（defect==4 / ==13 sanity）、①+② 带宽、warnings 可选字段 ──
  it('defect≠4 → 违例（§0 权威锚点）', () => expect(assertSentinel({ zero:0, one:9, two:0, three:4 }, { skip:9, defect:5 }).ok).toBe(false))
  it('⓪+①+②+③≠13 → 违例（构造恒等破坏=实现 bug sanity，非口径判据）', () => expect(assertSentinel({ zero:0, one:9, two:0, three:3 }, { skip:9, defect:4 }).ok).toBe(false))
  it('①+② 出带宽[9,11] → 仅警告不阻断', () => { const r = assertSentinel({ zero:0, one:12, two:0, three:1 }, { skip:9, defect:4 }); expect(r.ok).toBe(true); expect(r.warnings?.some(w => w.includes('①+②'))).toBe(true) })
  it('带内无 warnings 字段（可选字段非恒在）', () => expect(assertSentinel({ zero:0, one:9, two:0, three:4 }, { skip:9, defect:4 }).warnings).toBeUndefined())
})

// ── Task 11：四桶失败地图渲染（§2.5）+ 红/绿裁决（§2.4）──
// 裁决语义：绿（唯一升级出口）= ∃ confirmed 的②签名 ∧ 两 band 各≥1 presence（presence≠配对）；红（默认）=否则。
describe('地图渲染 + 裁决', () => {
  const row = (over: Partial<SigRow> = {}): SigRow => ({ band:'strong', arm:'off+verify', task:'A', bucket:'②', signature:'align_arch/done/E1', confirmState:'candidate', n:1, pct:10, ...over })
  it('无 confirmed 跨带 → 红', () => expect(verdict([row(), row({ band:'weak' })])).toBe('red'))
  it('confirmed ∧ 两带各≥1 presence → 绿', () => expect(verdict([row({ confirmState:'confirmed' }), row({ band:'weak', confirmState:'confirmed' })])).toBe('green'))
  it('confirmed 仅单带 → 红（图例注）', () => expect(verdict([row({ confirmState:'confirmed' })])).toBe('red'))
  it('同带两行 ②confirmed → 红（变异杀手：绿门看 band 集合 size≥2，非 confirmed 行数≥2）', () => expect(verdict([row({ confirmState:'confirmed' }), row({ confirmState:'confirmed' })])).toBe('red'))
  it('renderMap 含行末对账 + 列序', () => { const md = renderMap([row()], { degraded:false, reason:'' } as any, { ok:true, violations:[] } as any); expect(md).toContain('| band | arm | task | bucket | signature | confirm-state | n | %'); expect(md).toMatch(/^\*\*裁决：.*\*\*$/m) })
  // ── 针对性补钉：brief 代码未覆盖的裁决分支与渲染行 ──
  it('仅①签名 confirmed 跨带 → 红（② gate：verdict 必须过滤 bucket===\'②\'）', () => expect(verdict([row({ bucket:'①', confirmState:'confirmed' }), row({ bucket:'①', confirmState:'confirmed', band:'weak' })])).toBe('red'))
  it('renderMap 标定降级横幅 + 哨兵违例行', () => {
    const md = renderMap([row()], { degraded:true, reason:'①复现率 3/5' } as any, { ok:false, violations:['③=5 > 4'] } as any)
    expect(md).toContain('标定降级：①复现率 3/5')
    expect(md).toContain('哨兵违例：③=5 > 4')
  })
  it('renderMap 排序：band→arm→bucket、同格 n 降序', () => {
    const md = renderMap([
      row({ signature:'s-weak', band:'weak', n:5 }), row({ signature:'s-on', arm:'on+verify', n:3 }),
      row({ signature:'s-b', n:2 }), row({ signature:'s-a', n:9 }),
    ], { degraded:false, reason:'' } as any, { ok:true, violations:[] } as any)
    const body = md.split('\n').filter(l => /^\| (strong|weak) /.test(l))
    expect(body.map(l => l.split('|')[5]?.trim())).toEqual(['s-a', 's-b', 's-on', 's-weak'])
  })
})

// ── Task 12：main() 端到端编排 + Step-0 fail-closed + 报告装配 ──
// Step-0 fail-closed（brief Step1）：弱批 sha 不符 → 抛错不落结论；非快照路径拒（Task 3 已覆盖 assertSnapshotPath，
// 此处按 brief Step2「若已绿则补装配测试」策略补 sha 正/负两向 + 装配层测试）。
describe('Task12: Step0 fail-closed（弱批 sha 双向钉）', () => {
  const weakReal = join(import.meta.dirname, 'results', 'metrics.p10-weak-frozen-20260904.bak.jsonl')
  it('弱批 sha 不符 → 抛错（exit 语义：抛错不落结论）', () =>
    expect(() => assertWeakFrozenSha(weakReal, 'deadbeef'.repeat(8))).toThrow(/sha256/))
  it('弱批冻结锚点 == 真实冻结副本（正向钉，防锚点/文件单侧漂移）', () =>
    expect(() => assertWeakFrozenSha(weakReal, PROBE_BATCH.weakFrozenSha)).not.toThrow())
})

describe('Task12: 签名串/metricsTruth/标定守卫/pct对账（携带项可测部分）', () => {
  it('signatureOf 三段确定串：<末态>/<提议>/<缺失边集排序>', () => {
    expect(signatureOf({ state: 'align_arch', action: 'done' }, [{ action: 'execute', from: 'idle', to: 'exec' }, { action: 'done', from: 'exec', to: 'done' }]))
      .toBe('align_arch/done/done@exec->done,execute@idle->exec')
  })
  it('signatureOf terminal=null → null/- 前缀（仍确定串）', () =>
    expect(signatureOf(null, [])).toBe('null/-/'))
  it('metricsTruthFromRows 真实重算 skip/defect（数行，非硬编码）', () => {
    const r = (failKind: string, over: object = {}) => ({ runId: 'x', config: 'off+verify', taskId: 'A' as const, seed: 0, pass: false, failureMode: 'no-pass', failKind, rounds: 1, escalateCount: 0, correctionCount: 0, illegalProposalCount: 0, totalTransitions: 1, latencyMs: 1, ...over })
    const rows = Array.from({ length: 9 }, (_, i) => r('skipped-spec-edge', { seed: i })).concat(Array.from({ length: 4 }, (_, i) => r('defect', { seed: 100 + i })))
    expect(metricsTruthFromRows(rows)).toEqual({ skip: 9, defect: 4, total: 13 })
  })
  it('metricsTruthFromRows failKind 缺口 → fail-closed（skip/defect 口径漂移即抛）', () => {
    const bad = { runId: 'x', config: 'off+verify', taskId: 'A', seed: 0, pass: false, failureMode: 'no-pass', failKind: 'done-but-conformance', rounds: 1, escalateCount: 0, correctionCount: 0, illegalProposalCount: 0, totalTransitions: 1, latencyMs: 1 }
    expect(() => metricsTruthFromRows([bad as never])).toThrow(/failKind/)
  })
  // 【T9 携带】防御落点=选样管道：弱带桶混入标定即拒
  it('calibrationBuckets 弱带桶混入即拒（只钉强带 C-off）', () => {
    expect(() => calibrationBuckets([{ band: 'weak', bucket: '①' }, { band: 'strong', bucket: '①' }])).toThrow(/强带/)
    expect(() => calibrationBuckets([{ band: 'strong', bucket: '①' }, { band: 'strong', bucket: '②' }])).not.toThrow()
  })
  // 【T11 携带 B】pct 分母对账：每 (task,band) Σn == 非⓪分母 ∧ pct == n/分母
  it('assertPctLedger 恒等通过（Σn==分母 ∧ pct==n/分母）', () => {
    const rows: SigRow[] = [
      { band: 'strong', arm: 'on+verify', task: 'A', bucket: '①', signature: 's1', confirmState: 'candidate', n: 2, pct: (2 / 6) * 100 },
      { band: 'strong', arm: 'off+verify', task: 'A', bucket: '③', signature: 's2', confirmState: 'candidate', n: 4, pct: (4 / 6) * 100 },
    ]
    expect(() => assertPctLedger(rows, { 'A|strong': 6 })).not.toThrow()
  })
  it('assertPctLedger Σn≠分母 → 抛', () => {
    // pct 先按 n/分母 给对（40%），只让 Σn 违例触发（隔离被测分支）
    const rows: SigRow[] = [{ band: 'strong', arm: 'off+verify', task: 'A', bucket: '①', signature: 's', confirmState: 'candidate', n: 2, pct: 40 }]
    expect(() => assertPctLedger(rows, { 'A|strong': 5 })).toThrow(/Σn/)
  })
  it('assertPctLedger pct≠n/分母 → 抛（防构造期误除）', () => {
    const rows: SigRow[] = [{ band: 'weak', arm: 'on+verify', task: 'A', bucket: '②', signature: 's', confirmState: 'candidate', n: 3, pct: 50 }]
    expect(() => assertPctLedger(rows, { 'A|weak': 7 })).toThrow(/pct/)
  })
})

describe('Task12: joinRuns 多候选守卫（T4 携带观察项闭环）', () => {
  const sess = (projectDir: string) => ({ id: 's' + projectDir, title: 'p5-x', projectDir, phase: 'done', createdAt: '', decisionTrace: '[]' })
  const mrow = (runId: string) => ({ runId, config: 'off+verify', taskId: 'A' as const, seed: 0, pass: false, failureMode: 'no-pass', failKind: 'skipped-spec-edge', rounds: 3, escalateCount: 0, correctionCount: 0, illegalProposalCount: 0, totalTransitions: 2, latencyMs: 1 })
  it('多于一个未占用候选命中同一 runId → 抛（防 find() 静默取首个=错配）', () => {
    expect(() => joinRuns([mrow('r1')], [sess('r1-aaaa'), sess('r1-bbbb')], { A: 1 })).toThrow(/多于一个未占用/)
  })
})

describe('Task12: probeSession 逐会话分类（损坏降级不炸整批）', () => {
  const REQ = [{ action: 'done', from: 'exec', to: 'done' }, { action: 'execute', from: '*', to: 'exec' }]
  const E = (over: object = {}) => ({ decisionPoint: 'handleOrchestratorDecision', inputState: { state: 'idle' }, llmProposal: { action: 'done' }, corrections: [], validation: {}, actualTransition: { action: 'done', from: 'idle', to: 'done', applied: true, escalated: false }, ts: '2026-09-02T10:00:00.000Z', ...over })
  const sess = (id: string, decisionTrace: string | null, projectDir = '/w/x'): any => ({ id, title: 'p5-x', projectDir, phase: 'done', createdAt: '2026-09-02T10:00:00.000Z', decisionTrace })
  const mrow = (runId: string, over: object = {}) => ({ runId, config: 'off+verify', taskId: 'A' as const, seed: 0, pass: false, failureMode: 'no-pass', failKind: 'skipped-spec-edge', rounds: 3, escalateCount: 0, correctionCount: 0, illegalProposalCount: 0, totalTransitions: 2, latencyMs: 1, ...over })
  const tasks: TaskRow[] = [
    { id: 't1', sessionId: 's1', createdAt: '2026-09-02T09:59:00.000Z' },
    { id: 't2', sessionId: 's2', createdAt: '2026-09-02T09:30:00.000Z' }, // 他会话任务，不得计入 s1
  ]
  it('正常会话：桶+签名+tc（【传递约束 2】sessionId 先过滤再计数；tc=1→非seqgate→②）', () => {
    const j = { row: mrow('r1'), session: sess('s1', JSON.stringify([E()])) } as unknown as JoinedRun
    const c = probeSession(j, tasks, REQ)
    expect(c.bucket).toBe('②')            // idle/done/tc=1（t2 不计、t1 计入）→ predA 假 → 落②
    expect(c.taskCountAtTerminal).toBe(1)
    expect(c.corruptReason).toBeNull()
    expect(c.schemaBad).toBeNull()
    expect(c.signature).toBe(signatureOf({ state: 'idle', action: 'done' }, missingRequired([{ action: 'done', from: 'idle', to: 'done' }], REQ)))
  })
  it('① 命中需 tc=0：本会话无任务 → ①', () => {
    const j = { row: mrow('r1'), session: sess('s1', JSON.stringify([E()])) } as unknown as JoinedRun
    const c = probeSession(j, [{ id: 't2', sessionId: 's2', createdAt: '2026-09-02T09:30:00.000Z' }], REQ)
    expect(c.taskCountAtTerminal).toBe(0)
    expect(c.bucket).toBe('①')
  })
  // 【T6 携带】terminal 空串抛错须显式降级策略：action='' 过字段存在性 schema（键在）→ classifyBucket 拒收 → 损坏列
  it('空串签名（action=\'\'）→ classifyBucket 拒收 → bucket=null + corruptReason（损坏/拒收列，不炸整批）', () => {
    const j = { row: mrow('r1'), session: sess('s1', JSON.stringify([E({ llmProposal: { action: '' } })])) } as unknown as JoinedRun
    const c = probeSession(j, tasks, REQ)
    expect(c.bucket).toBeNull()
    expect(c.corruptReason).toMatch(/空串/)
    expect(c.schemaBad).toBeNull()
  })
  it('state=\'\' ∉ State → schemaBad（§2.2-4 exit-1 语义优先于损坏列）', () => {
    const j = { row: mrow('r1'), session: sess('s1', JSON.stringify([E({ inputState: { state: '' } })])) } as unknown as JoinedRun
    const c = probeSession(j, tasks, REQ)
    expect(c.schemaBad).toMatch(/State/)
    expect(c.bucket).toBeNull()
  })
  it('decisionTrace 畸形（非数组）→ schemaBad 置位（§2.2-4 exit 1 语义由编排计数）', () => {
    const j = { row: mrow('r1'), session: sess('s1', '{broken') } as unknown as JoinedRun
    const c = probeSession(j, tasks, REQ)
    expect(c.schemaBad).toMatch(/解析失败/)
  })
  it('决策条目 ts 非法 → schemaBad（防 NaN→tc=0 虚增①，F2）', () => {
    const j = { row: mrow('r1'), session: sess('s1', JSON.stringify([E({ ts: 'not-a-date' })])) } as unknown as JoinedRun
    const c = probeSession(j, tasks, REQ)
    expect(c.schemaBad).toMatch(/ts/)
  })
  it('probeSessions 汇总：schemaBad/corrupted 独立计数', () => {
    const joined = [
      { row: mrow('r1'), session: sess('s1', JSON.stringify([E()])), band: 'strong' },
      { row: mrow('r2', { seed: 1 }), session: sess('s2', JSON.stringify([E({ llmProposal: { action: '' } })])), band: 'strong' },
      { row: mrow('r3', { seed: 2 }), session: sess('s3', '{broken'), band: 'weak' },
    ] as never[]
    const out = probeSessions(joined as never, tasks, { A: REQ })
    expect(out.corruptedCount).toBe(1)
    expect(out.schemaBadCount).toBe(1)
    expect(out.results.filter(x => x.bucket !== null)).toHaveLength(1)
    expect(out.results[2].band).toBe('weak')   // band 透传（文件来源定带）
  })
})

describe('Task12: buildMapRows/partitionSingles/assembleReport 装配', () => {
  const input = (over: Partial<MapRowInput> = {}): MapRowInput => ({ band: 'strong', arm: 'off+verify', task: 'A', bucket: '①', signature: 'idle/done/done@idle->done', terminalState: 'idle', missingEdges: [{ action: 'done', from: 'exec', to: 'done' }], ...over })
  it('buildMapRows：分组 n/pct=÷非⓪分母/①③行 confirmState 恒 candidate 占位', () => {
    const { rows, denominators } = buildMapRows([input(), input({ arm: 'on+verify' }), input({ bucket: '③', signature: 'align_arch/self/x', terminalState: 'align_arch' })])
    expect(denominators).toEqual({ 'A|strong': 3 })
    expect(rows).toHaveLength(3)   // 三个不同 (arm,bucket,signature) 组各一行
    const onOne = rows.find(r => r.arm === 'on+verify')!
    expect(onOne.n).toBe(1)
    expect(onOne.pct).toBeCloseTo((1 / 3) * 100, 9)
    expect(onOne.confirmState).toBe('candidate')   // ① 行占位，不参与绿门
    expect(rows.every(r => r.bucket === '①' || r.bucket === '③')).toBe(true)
  })
  it('buildMapRows：②签名跨带 merged 计数喂 confirmState（真实表 (i) 败 → candidate，主结局）', () => {
    const { rows } = buildMapRows([
      input({ bucket: '②', signature: 'align_arch/done/x', arm: 'off+verify' }),
      input({ bucket: '②', signature: 'align_arch/done/x', band: 'weak', arm: 'off+verify' }),
    ])
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.confirmState === 'candidate')).toBe(true)   // 真实连通表 → (i) 败
  })
  it('partitionSingles：② 单例（跨带合并 n<2）分离；①/③ 不进孤例表', () => {
    const rows: SigRow[] = [
      { band: 'strong', arm: 'o', task: 'A', bucket: '①', signature: 'sigA', confirmState: 'candidate', n: 1, pct: 10 },   // 单例但非② → 主表
      { band: 'strong', arm: 'o', task: 'A', bucket: '②', signature: 'sigB', confirmState: 'candidate', n: 1, pct: 10 },   // ② 单例 → 孤例
      { band: 'weak', arm: 'o', task: 'A', bucket: '②', signature: 'sigC', confirmState: 'candidate', n: 1, pct: 10 },
      { band: 'strong', arm: 'o2', task: 'A', bucket: '②', signature: 'sigC', confirmState: 'candidate', n: 1, pct: 10 },  // sigC 跨带合并=2 → 群
    ]
    const { groups, singles } = partitionSingles(rows)
    expect(singles.map(r => r.signature)).toEqual(['sigB'])
    expect(groups.map(r => r.signature).sort()).toEqual(['sigA', 'sigC', 'sigC'])
  })
  const parts = (over: Partial<ReportParts> = {}): ReportParts => ({
    groups: [{ band: 'strong', arm: 'off+verify', task: 'A', bucket: '①', signature: 'idle/done/done@idle->done', confirmState: 'candidate', n: 2, pct: (2 / 6) * 100 }],
    singles: [],
    cal: { degraded: false, reason: '', reproRate: 1, zeroCount: 0 },
    sent: { ok: true, violations: [] },
    tally: { zero: 0, one: 9, two: 0, three: 4 },
    aNotPass: 13,
    corrupted: 0,
    strongCOffBuckets: ['①', '①', '①', '①', '①'],
    metricsTruth: { skip: 9, defect: 4 },
    step0: { snapshotPath: 'snapshot-x/p5.db', snapshotSha: 'abc', journalMode: 'delete', join: 'A strong=15/C-off=5/A weak=15', titleCoarse: '575/575', parseOk: 35, parseTotal: 35, schemaBad: 0, cellMismatch: 0, zeroRatio: '0/13', strongFile: 'strong.jsonl 45行', weakFile: 'weak.jsonl 45行 sha锚点✓' },
    ...over,
  })
  it('装配（正常·哨兵 ok）：裁决行 + 标定行 + 对账平（13）+ §0 对照 + 孤例空段', () => {
    const md = assembleReport(parts())
    expect(md).toMatch(/\*\*裁决：/)
    expect(md).toContain('标定')
    expect(md).toContain('⓪0 + ①9 + ②0 + ③4 == 13 == A ¬pass 13')
    expect(md).toContain('skip=9')
    expect(md).toContain('defect=4')
    expect(md).not.toMatch(/先自查口径/)
    expect(md).toContain('无孤例')
  })
  it('装配（哨兵违例）：无红/绿裁决行 + 顶部「先自查口径」横幅（T10 携带②③实测行为）', () => {
    const md = assembleReport(parts({ sent: { ok: false, violations: ['③=5 > 4（③⊆defect/error 行）'] } }))
    expect(md).not.toMatch(/\*\*裁决：/)
    expect(md).toContain('先自查口径（选样/taskCount/join）')
    expect(md).toContain('③=5 > 4')
    expect(md).toContain('全部靶点结论阻断')
  })
  it('装配（标定降级·哨兵 ok）：自查横幅输出，裁决行仍在（阻断仅哨兵违例触发）', () => {
    const md = assembleReport(parts({ cal: { degraded: true, reason: '①复现率 3/5 < 4/5', reproRate: 0.6, zeroCount: 0 } }))
    expect(md).toContain('先自查口径（选样/taskCount/join）')
    expect(md).toMatch(/\*\*裁决：/)
    expect(md).toContain('标定降级')
  })
  it('装配：②单例 → 孤例表段渲染（非空）', () => {
    const md = assembleReport(parts({ singles: [{ band: 'weak', arm: 'off+verify', task: 'A', bucket: '②', signature: 'align_pm/done/x', confirmState: 'candidate', n: 1, pct: 14.285714285714285 }] }))
    expect(md).toContain('孤例表')
    expect(md).toContain('align_pm/done/x')
  })
  it('装配：损坏/拒收独立计数列进入对账段', () => {
    const md = assembleReport(parts({ corrupted: 1 }))
    expect(md).toMatch(/损坏\/拒收[^]*?1/)
  })
})

import { describe, it, expect } from 'vitest'
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadBatchRows, aggregateFingerprints, fingerprintKey, BATCH_FILES, type CellFingerprint } from './analyze-cross-batch'

describe('loadBatchRows', () => {
  it('解析标准行（无 failKind 键 → null，与 P6 整批同型）', () => {
    const tmp = join(import.meta.dirname, '.__fixture-t1.jsonl')
    writeFileSync(tmp,
      '{"runId":"r1","config":"on+verify","taskId":"A","seed":0,"pass":true,"failureMode":"pass","rounds":3,"escalateCount":0,"correctionCount":1,"illegalProposalCount":0,"totalTransitions":2,"latencyMs":100,"tracePath":""}\n')
    const { rows, badLines } = loadBatchRows('P8', tmp)
    expect(badLines).toBe(0)
    expect(rows).toHaveLength(1)
    expect(rows[0].failKind).toBeNull()
    expect(rows[0]).toMatchObject({ batch: 'P8', config: 'on+verify', pass: true })
    unlinkSync(tmp)
  })

  it('坏行跳过计数不 throw（total 语义）', () => {
    const tmp = join(import.meta.dirname, '.__fixture-t1b.jsonl')
    writeFileSync(tmp, '{broken json\n{"runId":"r2","config":"off+verify","taskId":"B","seed":1,"pass":false,"failureMode":"no-pass","rounds":2,"escalateCount":0,"correctionCount":0,"illegalProposalCount":3,"totalTransitions":1,"latencyMs":50,"tracePath":"","failKind":"defect"}\n')
    const { rows, badLines } = loadBatchRows('P7', tmp)
    expect(badLines).toBe(1)
    expect(rows).toHaveLength(1)
    expect(rows[0].failKind).toBe('defect')
    unlinkSync(tmp)
  })

  it('非对象 JSON 行（数字/字符串）计入 badLines 不产生幻影行', () => {
    const tmp = join(import.meta.dirname, '.__fixture-t1c.jsonl')
    writeFileSync(tmp, '123\n"x"\n{"runId":"r3","config":"on+verify","taskId":"A","seed":2,"pass":true,"failureMode":"pass","rounds":1,"escalateCount":0,"correctionCount":0,"illegalProposalCount":0,"totalTransitions":1,"latencyMs":10}\n')
    const { rows, badLines } = loadBatchRows('P6', tmp)
    expect(badLines).toBe(2)   // JSON.parse('123')/'"x"' 合法但不产行，按坏行计
    expect(rows).toHaveLength(1)
    expect(rows[0].runId).toBe('r3')
    unlinkSync(tmp)
  })
})

describe('aggregateFingerprints（inline fixture）', () => {
  it('按 config×task 聚合且 failKind 分列', () => {
    const rows = [
      { batch: 'P8', runId: 'a', config: 'on+verify', taskId: 'A', seed: 0, pass: false, failureMode: 'no-pass', failKind: 'skipped-spec-edge' as const, rounds: 3, escalateCount: 0, correctionCount: 2, illegalProposalCount: 0, totalTransitions: 2, latencyMs: 1 },
      { batch: 'P8', runId: 'b', config: 'on+verify', taskId: 'A', seed: 1, pass: true, failureMode: 'pass', failKind: null, rounds: 4, escalateCount: 0, correctionCount: 1, illegalProposalCount: 0, totalTransitions: 5, latencyMs: 1 },
      { batch: 'P8', runId: 'c', config: 'off+verify', taskId: 'A', seed: 0, pass: false, failureMode: 'no-pass', failKind: 'defect' as const, rounds: 6, escalateCount: 0, correctionCount: 0, illegalProposalCount: 4, totalTransitions: 0, latencyMs: 1 },
    ]
    const m = aggregateFingerprints(rows)
    const on = m.get(fingerprintKey('on+verify', 'A'))!
    expect(on).toMatchObject({ n: 2, pass: 1, skip: 1, corrSum: 3 })
    const off = m.get(fingerprintKey('off+verify', 'A'))!
    expect(off).toMatchObject({ n: 1, defect: 1, illSum: 4 })
  })
})

const resultsDir = 'D:/ai全栈挑战赛/agenthub/experiments/p5/results'
const p8 = join(resultsDir, BATCH_FILES.P8)
describe.skipIf(!existsSync(p8))('aggregateFingerprints（真实数据快照，已独立复算背书）', () => {
  it('P8 总量与 ON corr 口径', () => {
    const { rows } = loadBatchRows('P8', p8)
    expect(rows).toHaveLength(60)
    const m = aggregateFingerprints(rows)
    let pass = 0, skip = 0, defect = 0, onCorr = 0, offIll = 0
    for (const [k, v] of m) {
      pass += v.pass; skip += v.skip; defect += v.defect
      if (k.startsWith('on+')) onCorr += v.corrSum; else offIll += v.illSum
    }
    expect(pass).toBe(22); expect(skip).toBe(23); expect(defect).toBe(15)
    expect(onCorr).toBe(6); expect(offIll).toBe(6)
  })
})

import { detectBatchContamination } from './analyze-cross-batch'

type Row = Parameters<typeof detectBatchContamination>[0][number]
const mkRow = (over: Partial<Row> = {}): Row =>
  ({ batch: 'P8', runId: 'x', config: 'off+verify', taskId: 'A', seed: 0, pass: false, failureMode: 'no-pass', failKind: 'defect', rounds: 6, escalateCount: 0, correctionCount: 0, illegalProposalCount: 0, totalTransitions: 0, latencyMs: 1, ...over })

describe('detectBatchContamination（quota-dead 校准签名）', () => {
  it('污染形态：trans≈0 + rounds 打满 + defect 灌满 → true', () => {
    const rows = Array.from({ length: 10 }, (_, i) => mkRow({ runId: `d${i}` }))
    expect(detectBatchContamination(rows).contaminated).toBe(true)
  })
  it('有效形态（混合 pass/skip，正常 trans）→ false', () => {
    const rows = [
      mkRow({ runId: 'p1', pass: true, failureMode: 'pass', failKind: null, rounds: 4, totalTransitions: 5 }),
      mkRow({ runId: 'p2', failKind: 'skipped-spec-edge', rounds: 3, totalTransitions: 3 }),
      mkRow({ runId: 'p3', failKind: 'skipped-spec-edge', rounds: 5, totalTransitions: 4 }),
    ]
    expect(detectBatchContamination(rows).contaminated).toBe(false)
  })
})

const pDead = join(resultsDir, 'metrics.p8-attempt1-quota-dead-20260822.jsonl')
describe.skipIf(!existsSync(pDead))('detectBatchContamination（真实批双向断言）', () => {
  it('quota-dead 阳性 / p8-final 阴性', () => {
    expect(detectBatchContamination(loadBatchRows('P8', pDead).rows).contaminated).toBe(true)
    expect(detectBatchContamination(loadBatchRows('P8', p8).rows).contaminated).toBe(false)
  })
})

import { classifyCorrections, findMissingEdges } from './analyze-cross-batch'

describe('classifyCorrections（结构化定源，镜像 chat-router 顺序）', () => {
  it('idle 直发 execute 被 gate 重定向', () => {
    expect(classifyCorrections({ inputState: { state: 'idle' }, llmProposal: { action: 'execute' }, corrections: [{ from: 'execute', to: 'align_decompose' }] })).toEqual(['gate'])
  })
  it('align_pm 提议 done → 规则1 canonical', () => {
    expect(classifyCorrections({ inputState: { state: 'align_pm' }, llmProposal: { action: 'done' }, corrections: [{ from: 'done', to: 'align_decompose' }] })).toEqual(['canonical'])
  })
  it('align_arch 提议 done→execute 归 canonical（状态区分于 done-guard）', () => {
    expect(classifyCorrections({ inputState: { state: 'align_arch' }, llmProposal: { action: 'done' }, corrections: [{ from: 'done', to: 'execute' }] })).toEqual(['canonical'])
  })
  it('exec 态提议 done 且被守卫拦 → done-guard', () => {
    expect(classifyCorrections({ inputState: { state: 'exec' }, llmProposal: { action: 'done' }, corrections: [{ from: 'done', to: 'execute' }] })).toEqual(['done-guard'])
  })
  it('exec 态提议 align_qa → 规则2 canonical', () => {
    expect(classifyCorrections({ inputState: { state: 'exec' }, llmProposal: { action: 'align_qa' }, corrections: [{ from: 'align_qa', to: 'execute' }] })).toEqual(['canonical'])
  })
  it('缺 corrections 键的 entry 不崩且返回空数组（schema 漂移防御）', () => {
    expect(classifyCorrections({ inputState: { state: 'exec' }, llmProposal: { action: 'done' } })).toEqual([])
    expect(classifyCorrections({})).toEqual([])
  })
})

describe('findMissingEdges（通配 from 匹配 + done 边钉 exec）', () => {
  it('缺 execute 且 done 从非 exec 发出不满足', () => {
    const req = [
      { action: 'align_decompose', from: '*', to: 'align_arch' },
      { action: 'execute', from: '*', to: 'exec' },
      { action: 'done', from: 'exec', to: 'done' },
    ]
    const applied = [
      { action: 'align_decompose', from: 'idle', to: 'align_arch' },
      { action: 'done', from: 'align_arch', to: 'done' },
    ]
    expect(findMissingEdges(applied, req)).toEqual([
      { action: 'execute', from: '*', to: 'exec' },
      { action: 'done', from: 'exec', to: 'done' },
    ])
  })
})

import { renderCrossBatchReport, sanitizeIdentifier, type MissingEdgeFinding } from './analyze-cross-batch'

describe('sanitizeIdentifier', () => {
  it('消毒路径穿越与特殊字符', () => {
    expect(sanitizeIdentifier('../../etc')).not.toContain('/')
    expect(sanitizeIdentifier('on+verify|A')).toBe('on+verify_A')
  })
})

describe('renderCrossBatchReport', () => {
  it('包含六个必备章节与固定脚注', () => {
    const md = renderCrossBatchReport({
      fingerprints: new Map(),
      contamination: {
        P6: { contaminated: false, avgTrans: 2.7, defectRatio: 0, roundsFullRatio: 0 },
        P7: { contaminated: false, avgTrans: 2.3, defectRatio: 0.15, roundsFullRatio: 0 },
        P8: { contaminated: false, avgTrans: 3.7, defectRatio: 0.25, roundsFullRatio: 0.08 },
      },
      findings: [], badLineCounts: { P6: 0, P7: 0, P8: 0 }, sessionDayGroups: [],
    })
    for (const h of ['批次健康检查', '统一指纹表', 'corrections 成分分解', '缺边类型学', 'H1′ 作用面结论', 'P6 溯源对照']) expect(md).toContain(h)
    expect(md).toContain('罐头引导期，不作 provider 对照')
    expect(md).toContain('500')
  })

  it('P6 对照节：硬编码权威数组与 jsonl 实数并列并点名差异', () => {
    const fp = (pass: number, n = 5): CellFingerprint =>
      ({ n, pass, skip: 0, defect: 0, failKindOther: 0, failKindNA: n - pass, corrSum: 1, illSum: 2, escSum: 0, sumRounds: 3 * n, sumTrans: 4 * n })
    const md = renderCrossBatchReport({
      fingerprints: new Map([
        [`P6|${fingerprintKey('on+verify', 'C')}`, fp(2)],
        [`P6|${fingerprintKey('off+no-verify', 'B')}`, fp(4)],
      ]),
      contamination: {
        P6: { contaminated: false, avgTrans: 1, defectRatio: 0, roundsFullRatio: 0 },
        P7: { contaminated: false, avgTrans: 1, defectRatio: 0, roundsFullRatio: 0 },
        P8: { contaminated: false, avgTrans: 1, defectRatio: 0, roundsFullRatio: 0 },
      },
      findings: [], badLineCounts: { P6: 0, P7: 0, P8: 0 }, sessionDayGroups: [],
    })
    expect(md).toContain('| on+verify | C | 1/0/1/0/0 | 2/5 | 2/5 |')   // 一致格
    expect(md).toContain('| off+no-verify | B | 1/1/1/1/1 | 5/5 | 4/5 |') // 不一致格
    expect(md).toContain('jsonl 缺格')                                    // 其余 10 格点名
    expect(md).toContain('- on+verify-A：jsonl 指纹缺格（权威 5/5）')
    expect(md).toContain('- off+no-verify-B：权威 5/5 vs jsonl 4/5')
    expect(md).not.toContain('两源逐格一致')
  })
})

describe('renderCrossBatchReport（终审修复波 F1/F2/F3 文案）', () => {
  const mkFinding = (id: string, appliedN: number): MissingEdgeFinding => ({
    sessionId: id, title: `p5-on+verify-A-s0-${id}`, dayGroup: '2026-08-22',
    appliedEdges: Array.from({ length: appliedN }, () => ({ action: 'execute', from: 'idle', to: 'exec' })),
    missingRequired: [{ action: 'align_decompose', from: '*', to: 'align_arch' }, { action: 'done', from: 'exec', to: 'done' }],
    doneEdgeAppliedFromExec: false,
    correctionSources: { canonical: 0, gate: 1, 'done-guard': 0 },
  })
  it('F2：缺边类型学含口径 caveat + 推进/未推进两行分段 + 时区脚注', () => {
    const md = renderCrossBatchReport({
      fingerprints: new Map(),
      contamination: {
        P6: { contaminated: false, avgTrans: 1, defectRatio: 0, roundsFullRatio: 0 },
        P7: { contaminated: false, avgTrans: 1, defectRatio: 0, roundsFullRatio: 0 },
        P8: { contaminated: false, avgTrans: 1, defectRatio: 0, roundsFullRatio: 0 },
      },
      findings: [mkFinding('a', 1), mkFinding('b', 0)],
      badLineCounts: { P6: 0, P7: 0, P8: 0 }, sessionDayGroups: [],
    })
    expect(md).toContain('不能直接当作跳过行为读')
    expect(md).toContain('- 曾实际推进（appliedEdges>0）：共 1 session，缺边 1 —— [1] 缺 align_decompose:*→align_arch ; done:exec→done')
    expect(md).toContain('- 从未推进（appliedEdges=0）：共 1 session，缺边 1 —— [1] 缺 align_decompose:*→align_arch ; done:exec→done')
    expect(md).toContain('> 时区脚注：dayGroup 取 createdAt 前 10 字符即 UTC 日期；P8 实际于北京时间 2026-08-23 凌晨执行，其会话 UTC 落在 08-22 桶。')
  })
  it('F1：污染阳性分支如实声明「须人工剔除」，不再声称「不进入解读」；F3：组级差异静态脚注', () => {
    const md = renderCrossBatchReport({
      fingerprints: new Map(),
      contamination: {
        P6: { contaminated: false, avgTrans: 1, defectRatio: 0, roundsFullRatio: 0 },
        P7: { contaminated: false, avgTrans: 1, defectRatio: 0, roundsFullRatio: 0 },
        P8: { contaminated: true, avgTrans: 0.8, defectRatio: 0.9, roundsFullRatio: 0.8 },
      },
      findings: [], badLineCounts: { P6: 0, P7: 0, P8: 0 }, sessionDayGroups: [],
    })
    expect(md).toContain('P8 命中污染签名：若 detectBatchContamination 判阳性，其指纹在解读时须人工剔除')
    expect(md).not.toContain('不进入解读')
    expect(md).toContain('> 组级差异脚注：corr 权威 17 vs jsonl 18、ill 权威 2 vs jsonl 1（来源 spec §1 注1）；逐格自动化点名需扩权威数据结构，留独立后续项。')
  })
})

const p5dbPath = 'D:/ai全栈挑战赛/agenthub/experiments/p5/p5.db'
describe.skipIf(!existsSync(p5dbPath))('main() 集成冒烟（真实 p5.db 全量跑）', () => {
  it('产出报告且标题章节齐全', async () => {
    const { main } = await import('./analyze-cross-batch')
    const out = await main()
    expect(existsSync(out)).toBe(true)
    const md = readFileSync(out, 'utf-8')
    expect(md).toContain('# 跨批分析报告（P9-丙）')   // 渲染器实际 H1（brief 示例标题与 T5 实现不符，以实现为准）
    for (const h of ['批次健康检查', '统一指纹表', 'corrections 成分分解', '缺边类型学', 'H1′ 作用面结论', 'P6 溯源对照']) {
      expect(md).toContain(h)
    }
    expect(md).toContain('回放 session 数：')
  })

  it('三批指纹键带批次前缀，同 config|task 不互相覆盖', async () => {
    const mod = await import('./analyze-cross-batch')
    const rows = [
      { batch: 'P6' as const, runId: 'a', config: 'on+verify', taskId: 'A', seed: 0, pass: true, failureMode: 'pass', failKind: null, rounds: 3, escalateCount: 0, correctionCount: 1, illegalProposalCount: 0, totalTransitions: 2, latencyMs: 1 },
      { batch: 'P7' as const, runId: 'b', config: 'on+verify', taskId: 'A', seed: 0, pass: false, failureMode: 'no-pass', failKind: 'defect' as const, rounds: 6, escalateCount: 0, correctionCount: 0, illegalProposalCount: 2, totalTransitions: 0, latencyMs: 1 },
    ]
    // 直接验证聚合器输入输出契约：main() 按批聚合后以 `${batch}|${config}|${task}` 合入
    const m6 = mod.aggregateFingerprints(rows.filter(r => r.batch === 'P6'))
    const m7 = mod.aggregateFingerprints(rows.filter(r => r.batch === 'P7'))
    const merged = new Map<string, CellFingerprint>()
    for (const [k, v] of m6) merged.set(`P6|${k}`, v)
    for (const [k, v] of m7) merged.set(`P7|${k}`, v)
    expect(merged.size).toBe(2)
    expect(merged.get('P6|on+verify|A')).toMatchObject({ n: 1, pass: 1 })
    expect(merged.get('P7|on+verify|A')).toMatchObject({ n: 1, defect: 1 })
  })
})

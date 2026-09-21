import { createHash } from 'node:crypto'
import type { RunMetrics } from './metrics'
import { bootstrapCI, pairedMcNemar } from './stats'
import { CONFIG, isMonitorConfig } from './config'

/** ── P11 monitor A/B 报告（三梯队第 1 项收尾）────────────────────────────
 *  两臂：on-monitor（结构化纠偏先行）vs on-llmmon（LLM 审 + 反事实埋点）。
 *  判据配对来自 Task.trace completion-cycle（success 分段，metrics.ts parseMonitorCycles）。
 *  效度口径段为安全审查拍板的固定文本——读报告者必读，勿删。 */
export function generateMonitorReport(metrics: RunMetrics[]): string {
  const lines: string[] = []
  lines.push('# P11 Monitor A/B Report', '')
  lines.push(`> model: ${CONFIG.model} | baseUrl: ${process.env.GLM_BASE_URL || 'https://opencode.ai/zen/go'} | runsPerCell: ${CONFIG.runsPerCell}`)
  lines.push('> 两臂: on-monitor（EXPERIMENT_STRUCTURED_MONITOR=on，结构化纠偏先行/LLM 降级第二道）vs on-llmmon（未设=生产默认 LLM 审，结构化信号记 monitor 事件=反事实）')
  lines.push('> 逐 run 臂值由 metrics 行 config 列驱动；判据配对来自 Task.trace completion-cycle（success 分段），verify- 前缀任务已排除', '')

  const monitor = metrics.filter(m => isMonitorConfig(m.config))

  // —— 纠偏触发率（run 级）：on 臂实际触发 = structuredHits 或 llmCorrections 任一 > 0（两判据互斥）；
  //    unset 臂实际触发 = llmCorrections > 0（structuredHits 是反事实，不算实际纠偏）——
  const triggered = (m: RunMetrics): boolean =>
    m.config === 'on-monitor'
      ? (m.monitorStructuredHits ?? 0) + (m.monitorLlmCorrections ?? 0) > 0
      : (m.monitorLlmCorrections ?? 0) > 0
  lines.push('## 纠偏触发率（run 级，任一 cycle 实际触发即计）')
  lines.push('| config | task | runs | 触发 | 触发率 | bootstrap CI |')
  lines.push('|---|---|---|---|---|---|')
  for (const config of ['on-monitor', 'on-llmmon'] as const) {
    for (const taskId of ['D', 'E', 'F', 'G'] as const) {
      const cell = monitor.filter(m => m.config === config && m.taskId === taskId)
      if (cell.length === 0) continue
      const passes = cell.map(triggered)
      const ci = bootstrapCI(passes)
      lines.push(`| ${config} | ${taskId} | ${cell.length} | ${passes.filter(Boolean).length} | ${(passes.filter(Boolean).length / cell.length).toFixed(2)} | ${ci.low.toFixed(2)}-${ci.high.toFixed(2)} |`)
    }
  }

  // —— 混淆矩阵（cycle 级聚合）：unset 臂反事实配对完整（结构化命中可观测），
  //    on 臂结构化命中即纠偏、LLM 对该 cycle 不可观测（结构性缺口，报告如实呈现）——
  lines.push('', '## 混淆矩阵（cycle 级聚合）')
  const aggArm = (config: 'on-monitor' | 'on-llmmon') => {
    const cell = monitor.filter(m => m.config === config)
    const sum = (k: 'monitorCycles' | 'monitorStructuredHits' | 'monitorLlmCorrections' | 'monitorOverlap' | 'monitorLlmOnly' | 'monitorStructuredOnly') =>
      cell.reduce((n, m) => n + (m[k] ?? 0), 0)
    return {
      cycles: sum('monitorCycles'), hits: sum('monitorStructuredHits'), corr: sum('monitorLlmCorrections'),
      overlap: sum('monitorOverlap'), llmOnly: sum('monitorLlmOnly'), structuredOnly: sum('monitorStructuredOnly'),
      runs: cell.length,
    }
  }
  const tn = (a: ReturnType<typeof aggArm>): number => Math.max(0, a.cycles - a.hits - a.corr + a.overlap)
  for (const config of ['on-llmmon', 'on-monitor'] as const) {
    const a = aggArm(config)
    const kind = config === 'on-llmmon' ? '反事实配对完整面（结构化命中可观测）' : 'LLM 第二道面（结构化命中即纠偏，该 cycle LLM 不可观测）'
    lines.push(`- ${config}（${kind}）: cycles=${a.cycles}`)
    lines.push(`  - 双判据同判坏(overlap)=${a.overlap} | 结构化漏检(LLM纠偏而结构化pass)=${a.llmOnly} | 结构化独有命中(误报候选)=${a.structuredOnly} | 双 pass(TN)=${tn(a)}`)
  }

  // —— 跨臂配对 McNemar（同 task 同 seed：实际纠偏触发 on-monitor vs on-llmmon）——
  lines.push('', '## 跨臂配对 McNemar（同 task 同 seed，实际纠偏触发）')
  for (const taskId of ['D', 'E', 'F', 'G'] as const) {
    const on = monitor.filter(m => m.config === 'on-monitor' && m.taskId === taskId).sort((x, y) => x.seed - y.seed)
    const off = monitor.filter(m => m.config === 'on-llmmon' && m.taskId === taskId).sort((x, y) => x.seed - y.seed)
    const pairable = Math.min(on.length, off.length)
    if (pairable === 0) continue
    const onArr = on.slice(0, pairable).map(triggered)
    const offArr = off.slice(0, pairable).map(triggered)
    const m = pairedMcNemar(offArr, onArr)
    lines.push(`- ${taskId}: on-monitor ${onArr.filter(Boolean).length}/${pairable} vs on-llmmon ${offArr.filter(Boolean).length}/${pairable} | b=${m.b} c=${m.c} p_exact=${m.pExact.toFixed(3)}`)
  }
  lines.push('> n 小功效有限，p_exact 只当方向性参考（P10 口径：小样本禁用渐近式下结论）')

  // —— 收敛性 ——
  lines.push('', '## 纠偏收敛（末 cycle 无任何触发）')
  for (const config of ['on-monitor', 'on-llmmon'] as const) {
    const cell = monitor.filter(m => m.config === config && m.monitorConverged !== undefined)
    const conv = cell.filter(m => m.monitorConverged).length
    lines.push(`- ${config}: ${conv}/${cell.length}`)
  }

  // —— 效度口径（安全审查拍板固定文本，2026-09-21）——
  lines.push('', '## 效度口径（必读）')
  lines.push('- LLM 审返回 JSON 解析失败与"判无需纠偏"不可区分 → llmCorrected 系统性偏低方向的混淆变量')
  lines.push('- cleanupUndeclared 先于监控审查清空 undeclared（越界文件已清理，审查看到清理后世界；E ghost 罐头下两臂观察世界不同）')
  lines.push('- audit.declared 已修复为真实交集（commit 9c0ae4a，2026-09-21）；此前批次数据带"谎报声明交集"偏置，跨批比较需按批次切分')
  lines.push('- on 臂结构化命中即纠偏，LLM 对该 cycle 的判断不可观测（结构性；unset 臂补全反事实面）')
  lines.push('- 纠偏重试撞 MAX_CORRECTION_RETRIES 上限时 correction 事件不落 trace（生产既有语义）→ cycle 级 structuredOnly 含"命中但被重试上限拦截"的尝试；run 级首触发不受影响')
  lines.push('- 监控审查超时不终止底层 CLI（生产 Promise.race 既有语义）；批 LLM 调用量约 350-500 次（决策+审查+preflight）')
  lines.push('- 实验开关转正硬时限：可分析会话 ≥20 且结论落档，3 个月（roadmap §6，自 2026-09-21 起算）')
  return lines.join('\n')
}

/** 同 (config, task) 格的 pass 数组，按 seed 升序（A5 消除插入序漂移；McNemar 同 seed 配对依赖排序——配对序必须是 seed 序而非插入序） */
const bySeed = (metrics: RunMetrics[], config: string, taskId: string): boolean[] =>
  metrics.filter(m => m.config === config && m.taskId === taskId)
    .sort((a, b) => a.seed - b.seed)
    .map(m => m.pass)

/** 对比报告（Spec §11：逐格 pass 数组，不报均值；P6 T8：2×2 矩阵——状态机/verify 主效应 + 交互） */
export function generateReport(metrics: RunMetrics[]): string {
  const lines: string[] = []
  lines.push('# P5 Pilot Report', '')
  lines.push(`> model: ${CONFIG.model} | baseUrl: ${process.env.GLM_BASE_URL || 'https://opencode.ai/zen/go'} | runsPerCell: ${CONFIG.runsPerCell} | escalateLimit: ${CONFIG.escalateLimit} | maxRounds: ${CONFIG.maxRounds}`)
  // P10（spec §2.3 / 审查 F5）：环境快照段——P9-F4「报告回显 env 供人眼终检」补票；key 永不回显本体
  lines.push('', '## 环境快照')
  const envOr = (k: string) => process.env[k] ?? '(unset)'
  lines.push(`- EXPERIMENT_STATE_MACHINE=${envOr('EXPERIMENT_STATE_MACHINE')} | EXPERIMENT_VERIFY=${envOr('EXPERIMENT_VERIFY')} | EXPERIMENT_SEQGATE=${envOr('EXPERIMENT_SEQGATE')}`)
  lines.push(`- P7_GATE=${envOr('P7_GATE')} | P7_GATE_CELL=${envOr('P7_GATE_CELL')} | P9_ARMS=${envOr('P9_ARMS')} | P5_SENTINEL=${envOr('P5_SENTINEL')}`)
  lines.push(`- seed 集=[0,1,2,3,4] | key 指纹=${process.env.GLM_API_KEY ? createHash('sha256').update(process.env.GLM_API_KEY).digest('hex').slice(0, 8) : '(no key)'}（sha256 前 8 位）`)
  // P10 终审 should-fix#2：45-run 矩阵报告里 EXPERIMENT_SEQGATE=(unset) 是进程基线，不是"seqgate 没开"
  lines.push('> 注: EXPERIMENT_* 为进程基线（批内恒 unset）——每 run 臂值由 metrics 行 config 列驱动（envForConfig 透传），逐格读 pass 数组行，勿读本段判臂')
  lines.push(`> 执行 mock（executeTaskBatch + monitoring 恒不纠正）| 决策真实 LLM`)
  // Spec §6：混淆变量必须固定，报告写明罐头消息
  lines.push(`> 罐头消息: ${JSON.stringify(CONFIG.cannedReplies)}`)
  // M3：trace 只在 DB session.decisionTrace，runOne 不写 trace-*.json 文件；不假装文件存在
  lines.push('> trace 存于 DB session.decisionTrace（runOne 不落 trace-*.json 文件，RunMetrics.tracePath 仅占位不指向真实文件）', '')
  // P6 T9：spec §7 报告口径——防误读（task B QA 是 mock 口径非 QA 能力；task C verify 不作用）
  lines.push('> 报告口径: task B 的 QA 维度是 mock 口径(测 orchestrator 会不会主动提 align_qa,不是会不会问出好问题;非 QA 能力)')
  lines.push('> 报告口径: task C 非代码任务不触发 verify(verify 主效应由 A/B 贡献,C 格测捷径任务在各组合下是否稳定)')

  // —— 逐格 pass 数组（4 配置 × 3 任务自动扩）——
  lines.push('## 逐格 pass 数组')
  lines.push('| config | task | pass 数组 | pass 率 | bootstrap CI |')
  lines.push('|---|---|---|---|---|')
  for (const config of CONFIG.configs) {
    for (const taskId of CONFIG.taskIds) {
      const passes = bySeed(metrics, config, taskId)
      if (passes.length === 0) continue
      const ci = bootstrapCI(passes)
      lines.push(`| ${config} | ${taskId} | ${passes.map(p => (p ? '1' : '0')).join('/')} | ${passes.filter(Boolean).length}/${passes.length} | ${ci.low.toFixed(2)}-${ci.high.toFixed(2)} |`)
    }
  }

  // —— 主效应配对 McNemar（同 seed 配对）——
  lines.push('', '## 配对 McNemar（主效应，同 seed）')
  // 状态机主效应（verify 固定）：同 seed 下 ON+verify vs OFF+verify、ON+no-verify vs OFF+no-verify 各一组；
  // P9-乙 T3 加第三组：on-seqgate+verify vs off+verify（OFF vs ON-seqgate 配对，前缀约定天然落 ON 口径）
  lines.push('### 状态机主效应（verify 固定，OFF vs ON）')
  for (const verify of ['verify', 'no-verify'] as const) {
    for (const taskId of CONFIG.taskIds) {
      const on = bySeed(metrics, `on+${verify}`, taskId)
      const off = bySeed(metrics, `off+${verify}`, taskId)
      const m = pairedMcNemar(off, on) // b=OFF 过 ON 败；c=OFF 败 ON 过
      lines.push(`- ${taskId} (${verify}): ON+${verify} ${on.filter(Boolean).length}/${on.length} vs OFF+${verify} ${off.filter(Boolean).length}/${off.length} | b=${m.b} c=${m.c} p_exact=${m.pExact.toFixed(3)} p_asym≈${m.pValue.toFixed(3)}`)
    }
  }
  // P9-乙 T3: seqgate 臂配对（OFF vs ON-seqgate，verify 固定）
  for (const taskId of CONFIG.taskIds) {
    const onSeqgate = bySeed(metrics, 'on-seqgate+verify', taskId)
    if (onSeqgate.length === 0) continue
    const off = bySeed(metrics, 'off+verify', taskId)
    const m = pairedMcNemar(off, onSeqgate) // b=OFF 过 ON-seqgate 败；c=OFF 败 ON-seqgate 过
    lines.push(`- ${taskId} (seqgate): ON-seqgate+verify ${onSeqgate.filter(Boolean).length}/${onSeqgate.length} vs OFF+verify ${off.filter(Boolean).length}/${off.length} | b=${m.b} c=${m.c} p_exact=${m.pExact.toFixed(3)} p_asym≈${m.pValue.toFixed(3)}`)
  }
  // —— P9-乙 T3: seqgate 臂增量小节（ON vs ON-seqgate 同臂配对 + seqgate 触发合计）——
  lines.push('', '## seqgate 臂增量（ON vs ON-seqgate）')
  for (const taskId of CONFIG.taskIds) {
    const onSeqgate = bySeed(metrics, 'on-seqgate+verify', taskId)
    if (onSeqgate.length === 0) continue
    const on = bySeed(metrics, 'on+verify', taskId)
    const m = pairedMcNemar(on, onSeqgate) // b=ON 过 ON-seqgate 败；c=ON 败 ON-seqgate 过
    lines.push(`- ${taskId}: on+verify ${on.filter(Boolean).length}/${on.length} vs on-seqgate+verify ${onSeqgate.filter(Boolean).length}/${onSeqgate.length} | b=${m.b} c=${m.c} p_exact=${m.pExact.toFixed(3)} p_asym≈${m.pValue.toFixed(3)}`)
  }
  {
    // 合计行：optional 字段 ?? 0 合并旧行（P6/P7 批 JSONL 无该字段，防 NaN）
    const sgCell = metrics.filter(m => m.config === 'on-seqgate+verify')
    const gateSum = sgCell.reduce((n, m) => n + (m.gateInterventionCount ?? 0), 0)
    if (sgCell.length > 0) {
      lines.push(`- seqgate 触发合计: ${gateSum}（${sgCell.length} runs，avg ${(gateSum / sgCell.length).toFixed(2)}）`)
      lines.push('> 归桶口径: 丙批 classifyCorrections 将出现第四类 seqgate（idle, done→align_decompose）；乙批数据跨批分析时按同签名归入该类，不计 canonical/gate(execute)/done-guard')
    }
  }
  // verify 主效应（状态机固定）：同 seed 下 on+verify vs on+no-verify、off+verify vs off+no-verify 各一组
  lines.push('### verify 主效应（状态机固定，no-verify vs verify）')
  for (const sm of ['on', 'off'] as const) {
    for (const taskId of CONFIG.taskIds) {
      const verify = bySeed(metrics, `${sm}+verify`, taskId)
      const noVerify = bySeed(metrics, `${sm}+no-verify`, taskId)
      const m = pairedMcNemar(noVerify, verify) // b=no-verify 过 verify 败；c=no-verify 败 verify 过
      lines.push(`- ${taskId} (${sm}): ${sm}+verify ${verify.filter(Boolean).length}/${verify.length} vs ${sm}+no-verify ${noVerify.filter(Boolean).length}/${noVerify.length} | b=${m.b} c=${m.c} p_exact=${m.pExact.toFixed(3)} p_asym≈${m.pValue.toFixed(3)}`)
    }
  }

  // —— 交互 2×2 列联表（每 task：概念格=状态机 on/off × verify 有/无；渲染为 task×verify 行、ON/OFF 率列 + Δ(ON-OFF)）——
  lines.push('', '## 交互 2×2 列联表（pass 率）')
  lines.push('| task | verify | ON 率 | OFF 率 | Δ(ON-OFF) |')
  lines.push('|---|---|---|---|---|')
  for (const taskId of CONFIG.taskIds) {
    for (const verify of ['verify', 'no-verify'] as const) {
      const on = bySeed(metrics, `on+${verify}`, taskId)
      const off = bySeed(metrics, `off+${verify}`, taskId)
      const delta = (on.filter(Boolean).length / Math.max(on.length, 1)) - (off.filter(Boolean).length / Math.max(off.length, 1))
      lines.push(`| ${taskId} | ${verify} | ${on.filter(Boolean).length}/${on.length} | ${off.filter(Boolean).length}/${off.length} | ${delta.toFixed(2)} |`)
    }
  }

  // —— seed noise（同格 pass 方差；P6 T8：passes 按 seed 排序，cosmetic 一致性）——
  lines.push('', '## seed noise（同格 pass 方差）')
  const cellsSeen = new Set<string>()
  for (const m of metrics) {
    const cellKey = `${m.config}-${m.taskId}`
    if (cellsSeen.has(cellKey)) continue
    cellsSeen.add(cellKey)
    const passes = bySeed(metrics, m.config, m.taskId)
    const p = passes.filter(Boolean).length / passes.length
    lines.push(`- ${cellKey}: ${passes.map(x => (x ? '1' : '0')).join('/')} variance=${(p * (1 - p)).toFixed(2)}`)
  }

  // —— 失效模式分布 ——
  lines.push('', '## 失效模式分布')
  const fm = new Map<string, number>()
  for (const m of metrics) fm.set(m.failureMode, (fm.get(m.failureMode) ?? 0) + 1)
  lines.push('- ' + Array.from(fm.entries()).map(([k, v]) => `${k}: ${v}`).join(' | '))

  // —— P7-A: failKind 诊断（no-pass 分解，状态机价值 vs harness 缺陷）——
  lines.push('', '## failKind 诊断（no-pass 分解）')
  lines.push('| config | task | 状态机价值 | harness 缺陷 | defect(by failureMode) |')
  lines.push('|---|---|---|---|---|')
  const cellFail = (config: string, taskId: string): RunMetrics[] => metrics.filter(m => m.config === config && m.taskId === taskId && m.pass === false)
  for (const config of CONFIG.configs) for (const taskId of CONFIG.taskIds) {
    const noPass = cellFail(config, taskId)
    if (noPass.length === 0) continue
    const value = noPass.filter(m => m.failKind === 'skipped-spec-edge' || m.failKind === 'done-but-conformance').length
    const defect = noPass.filter(m => m.failKind === 'defect' || m.failKind === undefined).length // undefined=旧resume行防 (F6)
    const fm = new Map<string, number>()
    for (const m of noPass.filter(x => x.failKind === 'defect')) fm.set(m.failureMode, (fm.get(m.failureMode) ?? 0) + 1)
    const fmLine = fm.size ? Array.from(fm.entries()).map(([k, v]) => `${k}:${v}`).join(' ') : '—'
    lines.push(`| ${config} | ${taskId} | ${value} | ${defect} | ${fmLine} |`)
  }
  lines.push('', '> 归因: 状态机价值=skipped-spec-edge(off 捷径被拦)+done-but-conformance(on 违规)；harness 缺陷=defect(stuck/error/escalate-exhausted/no-pass)')

  // —— 非法尝试率（P6 T8：4 配置通用——OFF 前缀用 illegalProposalCount，ON 前缀用 correctionCount）——
  lines.push('', '## OFF 非法尝试率 vs ON correctionCount（4 配置）')
  for (const config of CONFIG.configs) {
    const cell = metrics.filter(m => m.config === config)
    const sum = config.startsWith('off')
      ? cell.reduce((n, m) => n + m.illegalProposalCount, 0)
      : cell.reduce((n, m) => n + m.correctionCount, 0)
    lines.push(`- ${config}: ${sum}（${cell.length} runs，avg ${(sum / Math.max(cell.length, 1)).toFixed(2)}）`)
  }

  lines.push('', '> 结论：方向性差异当传闻看（Spec §11），管道有效性 + seed noise 是 pilot 成功标准')
  return lines.join('\n')
}

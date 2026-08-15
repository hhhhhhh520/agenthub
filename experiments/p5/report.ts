import type { RunMetrics } from './metrics'
import { bootstrapCI, pairedMcNemar } from './stats'
import { CONFIG } from './config'

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
  lines.push(`> 执行 mock（executeTaskBatch + monitoring 恒不纠正）| 决策真实 LLM`)
  // Spec §6：混淆变量必须固定，报告写明罐头消息
  lines.push(`> 罐头消息: ${JSON.stringify(CONFIG.cannedReplies)}`)
  // M3：trace 只在 DB session.decisionTrace，runOne 不写 trace-*.json 文件；不假装文件存在
  lines.push('> trace 存于 DB session.decisionTrace（runOne 不落 trace-*.json 文件，RunMetrics.tracePath 仅占位不指向真实文件）', '')

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
  // 状态机主效应（verify 固定）：同 seed 下 ON+verify vs OFF+verify、ON+no-verify vs OFF+no-verify 各一组
  lines.push('### 状态机主效应（verify 固定，OFF vs ON）')
  for (const verify of ['verify', 'no-verify'] as const) {
    for (const taskId of CONFIG.taskIds) {
      const on = bySeed(metrics, `on+${verify}`, taskId)
      const off = bySeed(metrics, `off+${verify}`, taskId)
      const m = pairedMcNemar(off, on) // b=OFF 过 ON 败；c=OFF 败 ON 过
      lines.push(`- ${taskId} (${verify}): ON+${verify} ${on.filter(Boolean).length}/${on.length} vs OFF+${verify} ${off.filter(Boolean).length}/${off.length} | b=${m.b} c=${m.c} p≈${m.pValue.toFixed(3)}`)
    }
  }
  // verify 主效应（状态机固定）：同 seed 下 on+verify vs on+no-verify、off+verify vs off+no-verify 各一组
  lines.push('### verify 主效应（状态机固定，no-verify vs verify）')
  for (const sm of ['on', 'off'] as const) {
    for (const taskId of CONFIG.taskIds) {
      const verify = bySeed(metrics, `${sm}+verify`, taskId)
      const noVerify = bySeed(metrics, `${sm}+no-verify`, taskId)
      const m = pairedMcNemar(noVerify, verify) // b=no-verify 过 verify 败；c=no-verify 败 verify 过
      lines.push(`- ${taskId} (${sm}): ${sm}+verify ${verify.filter(Boolean).length}/${verify.length} vs ${sm}+no-verify ${noVerify.filter(Boolean).length}/${noVerify.length} | b=${m.b} c=${m.c} p≈${m.pValue.toFixed(3)}`)
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

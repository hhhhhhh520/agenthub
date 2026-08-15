import type { RunMetrics } from './metrics'
import { bootstrapCI, pairedMcNemar, seedNoise } from './stats'
import { CONFIG } from './config'

/** 对比报告（Spec §11：逐格 pass 数组，不报均值） */
export function generateReport(metrics: RunMetrics[]): string {
  const lines: string[] = []
  lines.push('# P5 Pilot Report', '')
  lines.push(`> model: ${CONFIG.model} | baseUrl: ${process.env.GLM_BASE_URL || 'https://opencode.ai/zen/go'} | runsPerCell: ${CONFIG.runsPerCell} | escalateLimit: ${CONFIG.escalateLimit} | maxRounds: ${CONFIG.maxRounds}`)
  lines.push(`> 执行 mock（executeTaskBatch + monitoring 恒不纠正）| 决策真实 LLM`)
  // Spec §6：混淆变量必须固定，报告写明罐头消息
  lines.push(`> 罐头消息: ${JSON.stringify(CONFIG.cannedReplies)}`)
  // M3：trace 只在 DB session.decisionTrace，runOne 不写 trace-*.json 文件；不假装文件存在
  lines.push('> trace 存于 DB session.decisionTrace（runOne 不落 trace-*.json 文件，RunMetrics.tracePath 仅占位不指向真实文件）', '')
  lines.push('## 逐格 pass 数组')
  lines.push('| config | task | pass 数组 | pass 率 | bootstrap CI |')
  lines.push('|---|---|---|---|---|')
  for (const config of CONFIG.configs) {
    for (const taskId of CONFIG.taskIds) {
      const cell = metrics.filter(m => m.config === config && m.taskId === taskId)
      if (cell.length === 0) continue
      const passes = cell.map(m => m.pass)
      const ci = bootstrapCI(passes)
      lines.push(`| ${config} | ${taskId} | ${passes.map(p => (p ? '1' : '0')).join('/')} | ${passes.filter(Boolean).length}/${passes.length} | ${ci.low.toFixed(2)}-${ci.high.toFixed(2)} |`)
    }
  }
  lines.push('', '## 配对 McNemar（同 seed，ON vs OFF）')
  for (const taskId of CONFIG.taskIds) {
    const off = metrics.filter(m => m.config === 'off' && m.taskId === taskId).map(m => m.pass)
    const on = metrics.filter(m => m.config === 'on' && m.taskId === taskId).map(m => m.pass)
    const m = pairedMcNemar(off, on)
    lines.push(`- ${taskId}: OFF${off.filter(Boolean).length}/${off.length} vs ON${on.filter(Boolean).length}/${on.length} | b=${m.b} c=${m.c} p≈${m.pValue.toFixed(3)}`)
  }
  lines.push('', '## seed noise（同格 pass 方差）')
  for (const s of seedNoise(metrics)) {
    lines.push(`- ${s.cell}: ${s.passes.map(p => (p ? '1' : '0')).join('/')} variance=${s.variance.toFixed(2)}`)
  }
  lines.push('', '## 失效模式分布')
  const fm = new Map<string, number>()
  for (const m of metrics) fm.set(m.failureMode, (fm.get(m.failureMode) ?? 0) + 1)
  lines.push('- ' + Array.from(fm.entries()).map(([k, v]) => `${k}: ${v}`).join(' | '))
  lines.push('', '## OFF 非法尝试率 vs ON correctionCount')
  for (const config of CONFIG.configs) {
    const cell = metrics.filter(m => m.config === config)
    const sum = config === 'off'
      ? cell.reduce((n, m) => n + m.illegalProposalCount, 0)
      : cell.reduce((n, m) => n + m.correctionCount, 0)
    lines.push(`- ${config}: ${sum}（${cell.length} runs，avg ${(sum / Math.max(cell.length, 1)).toFixed(2)}）`)
  }
  lines.push('', '> 结论：方向性差异当传闻看（Spec §11），管道有效性 + seed noise 是 pilot 成功标准')
  return lines.join('\n')
}

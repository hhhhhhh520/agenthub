/**
 * §3.4 monitoring 结构化——信号层纯函数（roadmap；三梯队第 1 项 A/B 实验的信号面）
 *
 * 现状（2026-09-27 转正，roadmap v12）：结构化监控为生产默认——未设 env = on
 * （结构化 correction 直接触发纠偏，pass 时 LLM 作为第二道）；显式 'off' = 复现转正前行为
 * （只 LLM 审，信号命中记 Task.trace(event:'monitor')——对照/逃生门）。
 * 本模块把结构化信号收敛为可测试的纯判定，接线语义见 isStructuredMonitorOn。
 * 转正依据：experiments/p5/results/report.monitor-2026-09-26/27.md（S1/S2 40/40 cycle 零漏检、
 * 30 run 基线零误报、合并 McNemar E p_exact=0.0625）。
 *
 * 信号定义：
 *   S1 declared_files_untouched——declaredFiles 非空且声明∩实际变更为空（声称完成但无产出）。
 *      防御：仅当 changedFiles.length > 0 时判定——batch diff 整体为空可能是快照链路故障
 *      而非任务没产出，避免系统性误报（ISSUE-011 F3 记录过 batch 快照差异的已知限制）。
 *   S2 output_schema_violation——validateAgainstSchema 不通过（no-json/parse-error/missing-fields；
 *      no-schema = 未声明 schema，不参与）。
 *
 * 纯函数，不写库不调 LLM；纠偏触发与 trace 落库由 execution.ts 接线（同段代码，roadmap §3.4）。
 */

import type { SchemaValidationResult } from '@/lib/services/schema-validator'

/** §3.4 结构化监控开关——2026-09-27 用户拍板**转正为生产默认**（roadmap v12）。
 *  默认反转：未设 = on（结构化先行 + LLM 第二道），仅显式 'off' 关闭
 *  （逃生门 + p5 装置 on-llmmon 对照臂兼容——该臂显式 'off' 复现转正前行为）。
 *  转正依据：experiments/p5/results/report.monitor-2026-09-26/27.md
 *  （S1/S2 累计 40/40 cycle 零漏检、30 run 基线零误报、合并 McNemar E p_exact=0.0625；
 *  转正不减少防线——LLM 审在结构化 pass 后照跑）。 */
export function isStructuredMonitorOn(): boolean {
  return process.env.EXPERIMENT_STRUCTURED_MONITOR !== 'off'
}

export interface MonitorSignal {
  kind: 'declared_files_untouched' | 'output_schema_violation'
  detail: string
}

export interface StructuredMonitorInput {
  declaredFiles: string[]
  /** batch 级 shadow-git 快照差异（getChangedFiles 结果） */
  changedFiles: string[]
  /** validateAgainstSchema 的结果（execution.ts 已算好，传入避免重复校验） */
  schemaCheck: SchemaValidationResult
}

export interface StructuredMonitorVerdict {
  verdict: 'pass' | 'correction'
  signals: MonitorSignal[]
}

/** S1/S2 判定：命中任一信号 → correction（结构化纠偏判据） */
export function structuredMonitorVerdict(input: StructuredMonitorInput): StructuredMonitorVerdict {
  const signals: MonitorSignal[] = []
  const { declaredFiles, changedFiles, schemaCheck } = input

  // S1：git-truth 完成性——声明了文件、batch diff 非空（快照链路活着）、但声明∩变更=空
  if (declaredFiles.length > 0 && changedFiles.length > 0) {
    // 归一化必须与 execution.ts 导出的 normalizePath 保持逐字符一致（不能直接 import：
    // execution → structured-monitor → execution 会成循环依赖；漂移会使 S1 与 undeclared 判定口径分叉）
    const normalize = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
    const changedSet = new Set(changedFiles.map(normalize))
    const touched = declaredFiles.filter(f => changedSet.has(normalize(f)))
    if (touched.length === 0) {
      signals.push({ kind: 'declared_files_untouched', detail: declaredFiles.join(', ') })
    }
  }

  // S2：outputSchema 校验失败（no-schema = 未声明，不参与）
  if (!schemaCheck.valid && schemaCheck.status !== 'no-schema') {
    signals.push({ kind: 'output_schema_violation', detail: schemaCheck.message })
  }

  return { verdict: signals.length > 0 ? 'correction' : 'pass', signals }
}

/** 信号 → 纠偏 prompt 摘要（correctionNote 风格，LLM 第二道 / trace 事件共用） */
export function describeSignal(signal: MonitorSignal): string {
  if (signal.kind === 'declared_files_untouched') {
    return `声明的产出文件（${signal.detail}）在 git 快照中未变更——任务声称完成但无文件产出`
  }
  return `产出物未通过声明的字段校验：${signal.detail}`
}

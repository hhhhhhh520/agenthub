/** P5 实验配置（Spec §2/§4/§6 固化参数，报告需回显 model+config 供复现）
 *  model/baseUrl 支持 env 覆盖：GLM_MODEL / GLM_BASE_URL（用户可换 provider/模型，报告按实际值回显） */
export const CONFIG = {
  model: process.env.GLM_MODEL || 'deepseek-v4-flash',
  taskIds: ['A', 'B', 'C'] as const,
  configs: ['on', 'off'] as const,
  runsPerCell: 5,
  escalateLimit: 3,
  maxRounds: 30,
  noProgressRounds: 5,
  dbPath: 'file:D:/ai全栈挑战赛/agenthub/experiments/p5/p5.db',
  workDir: 'D:/ai全栈挑战赛/agenthub/experiments/p5/work',
  resultsDir: 'D:/ai全栈挑战赛/agenthub/experiments/p5/results',
  // 与 vitest testTimeout 同值（30min），globalDeadline 源头：run-one.ts → globalDeadline → execution.ts 硬判
  timeoutMs: 30 * 60 * 1000,
  // 暂停点罐头消息（Spec §6：混淆变量必须固定，报告写明）
  cannedReplies: {
    escalate: '请按流程继续',
    pm_confirm: '方案确认，继续',
    architect_plan: '拆解确认，继续',
    replan: '请重新规划，继续',
    agent_qa: '已解答，继续',
  } as Record<string, string>,
} as const

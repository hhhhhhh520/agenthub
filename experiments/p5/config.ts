/** P5 实验配置（Spec §2/§4/§6 固化参数，报告需回显 model+config 供复现）
 *  model/baseUrl 支持 env 覆盖：GLM_MODEL / GLM_BASE_URL（用户可换 provider/模型，报告按实际值回显） */
/** P6 T8: 配置名 → 实验 env 透传（configs 扩 2×2 矩阵：OFF 前缀关状态机，no-verify 前缀关 verify，否则未设=默认 on）
 *  P9-乙 T3: 三臂扩展——EXPERIMENT_SEQGATE 仅 on-seqgate 前缀产出 'on'（F4 严格值透传：'1'/'true' 一律不激活，
 *  生产 isSeqgateOn() 只认 ==='on'）；保 startsWith 前缀约定（metrics/report 的 startsWith('off')/('on') 对
 *  'on-seqgate+verify' 天然落 ON 口径） */
export const envForConfig = (config: string) => ({
  EXPERIMENT_STATE_MACHINE: config.startsWith('off') ? 'off' : undefined,
  EXPERIMENT_VERIFY: config.includes('no-verify') ? 'off' : undefined,
  EXPERIMENT_SEQGATE: config.startsWith('on-seqgate') ? 'on' : undefined,
})

/** P9-乙 T5: 全矩阵三臂选择门控——P9 拍板「verify 砍掉固定 on」（45 run = 三臂×ABC×5），
 *  但 configs 数组保留 5 配置以维持 P6 2×2 harness 语义；P9_ARMS='1'（严格相等，同 F4）时
 *  驱动循环跳过 no-verify 格。未设=全 5 配置，P6/P7 行为不变。 */
export const isP9ArmsOnly = (env: NodeJS.ProcessEnv = process.env): boolean => env.P9_ARMS === '1'

export const CONFIG = {
  model: process.env.GLM_MODEL || 'deepseek-v4-flash',
  taskIds: ['A', 'B', 'C'] as const,
  // P9-乙 T3: 三臂矩阵——on-seqgate+verify = ON 臂 + seqgate 守卫（idle 过早 done 拦截）；前缀约定保 ON 口径
  configs: ['on+verify', 'on+no-verify', 'off+verify', 'off+no-verify', 'on-seqgate+verify'] as const,
  envForConfig, // P6 T8：CONFIG.envForConfig 与独立导出同源（run-one 透传消费，同 seed 配对两两正交）
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

import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { CONFIG } from './config'

const REPO_ROOT = join(__dirname, '..', '..')

/** P9-乙 T4（F2）：候选模型 ID 白名单——cmd.exe 元字符集 &|^<>()%!" 空格 反引号 $ CR LF \ 全排除（审查 E 核对）。
 *  模型 ID 真实流向 GLM_MODEL→CONFIG.model→ensureExperimentAgents upsert→spawn --model，畸形 ID 即注入面 */
export function isValidModelId(id: string): boolean {
  return /^[A-Za-z0-9._\/:-]+$/.test(id)
}

// 【审查 F 必修】白名单包含判定：resolve 统一斜杠 + experiments/p5 前缀检查。
// 原子串猜测方案（includes('\\.claude') && !includes('p5')）对正斜杠形态 fail-open，
// 且 p5 子串可被用户名击穿/误伤合法目录——已废弃。
const ALLOW_PREFIX = resolve(import.meta.dirname)   // experiments/p5

/** '~' 形态先按家目录语义展开再进 resolve 判定——否则 resolve 把 '~' 当相对路径段，
 *  cwd 恰在 experiments/p5 内时 '~/.claude' 会被误判进白名单（fail-open）。 */
function expandTilde(dir: string): string {
  if (dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\')) return join(homedir(), dir.slice(1))
  return dir
}

/** P9-乙 T4（F3）：CLI 子进程继承用户默认 CLAUDE_CONFIG_DIR 会启动挂死（P8 实证）——preflight 强制断言隔离目录 */
export function assertCliConfigDir(raw: string | undefined): void {
  const d = raw ? resolve(expandTilde(raw)) : ''
  if (!d || !(d === ALLOW_PREFIX || d.startsWith(ALLOW_PREFIX + sep))) {
    throw new Error('[preflight] CLAUDE_CONFIG_DIR 未隔离——CLI 子进程将继承用户默认目录导致挂死（P8 实证）。请设为实验专属目录（experiments/p5 之下）。')
  }
}

/** P9-乙 T5-1（ISSUE-013）：清洗继承的 provider/session env——Gate 冒烟 401 根因修复。
 *  泄漏链：交互式 Claude Code 会话（本地 qwen 代理，settings.json env 块）→ 启动器 → vitest →
 *  process-registry.ts:349-351 spawn `env: {...process.env, ...providerEnv}`——providerEnv 只覆盖
 *  ANTHROPIC_API_KEY/BASE_URL（来自 DB 配置），ANTHROPIC_AUTH_TOKEN/ANTHROPIC_MODEL/ANTHROPIC_DEFAULT_*
 *  与 CLAUDECODE/CLAUDE_PID/CLAUDE_CODE_* 原样漏进 CLI 子进程 → CLI 同时发 Bearer(代理token)+x-api-key(讯飞key)，
 *  讯飞优先验 Bearer → 401 "HMAC signature cannot be verified: apikey not found"（2026-08-28 实测逐字复现）。
 *  全清 ANTHROPIC_ 前缀与 CLAUDE_ 前缀（唯一豁免 CLAUDE_CONFIG_DIR——F3 隔离目录本体；CLAUDECODE 精确匹配），
 *  正主凭据不受影响：其走 GLM_* env → DB agent → providerEnv 逐次注入，与 process.env 解耦。
 *  返回被清键名列表（供日志回显）。幂等。 */
export function scrubInheritedProviderEnv(): string[] {
  const scrubbed: string[] = []
  for (const k of Object.keys(process.env)) {
    if (k === 'CLAUDE_CONFIG_DIR') continue
    if (k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_') || k === 'CLAUDECODE') {
      delete process.env[k]
      scrubbed.push(k)
    }
  }
  return scrubbed
}

/** 清 prisma 全局单例，确保下一次 import 用 p5.db（db.ts 模块级 globalForPrisma.prisma） */
export function resetPrismaSingleton(): void {
  ;(globalThis as unknown as { prisma?: unknown }).prisma = undefined
}

/** migrate deploy 到 p5.db（空库无表，不部署则 30/30 error；cwd 必须与 DATABASE_URL 相对基准一致） */
export function initP5Db(): void {
  mkdirSync(CONFIG.workDir, { recursive: true })
  mkdirSync(CONFIG.resultsDir, { recursive: true })
  execSync('npx prisma migrate deploy --schema prisma/schema.prisma', {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: CONFIG.dbPath },
    stdio: 'pipe',
  })
}

/** 实验 agents（决策/PM/架构师走真实 LLM——deepseek-v4-flash，经 claude-code adapter + ANTHROPIC 兼容路径） */
export async function ensureExperimentAgents(): Promise<void> {
  const key = process.env.GLM_API_KEY
  if (!key || !key.trim()) {
    throw new Error('GLM_API_KEY env 未设置——pilot 需要实验 LLM key（env 名沿用 GLM_API_KEY，端点 opencode.ai/zen/go，永不硬编码）')
  }
  // P9-乙 T4（F2）：模型 ID 入口闸门——畸形 GLM_MODEL 在 upsert 进 Agent 表之前拦下（下游 spawn shell:true 即注入面）
  if (!isValidModelId(CONFIG.model)) {
    throw new Error(`model ID 白名单校验失败: ${JSON.stringify(CONFIG.model)}——仅允许 [A-Za-z0-9._/:-]，请检查 GLM_MODEL env`)
  }
  const { prisma } = await import('@/lib/db')
  const common = {
    platform: 'claude-code',
    model: CONFIG.model,
    baseUrl: process.env.GLM_BASE_URL || 'https://opencode.ai/zen/go',
    apiKey: key,
    accentColor: '#6366f1',
  }
  const agents = [
    { ...common, name: '产品经理', expertise: '需求分析与澄清', systemPrompt: '你是产品经理，负责需求分析与澄清，可向用户提问确认需求。', isOrchestrator: false },
    { ...common, name: '架构师', expertise: '系统设计与任务拆解', systemPrompt: '你是架构师，负责把需求拆解为可执行任务。', isOrchestrator: true },
    { ...common, name: '后端工程师', expertise: '后端与脚本开发', systemPrompt: '你是后端工程师，负责实现 API 与业务逻辑。', isOrchestrator: false },
    { ...common, name: '测试工程师', expertise: '测试编写与验证', systemPrompt: '你是测试工程师，负责编写测试并验证实现。', isOrchestrator: false },
  ]
  for (const a of agents) {
    await prisma.agent.upsert({
      where: { name: a.name },
      // P6 A4：二次运行刷新 model/baseUrl/apiKey（update:{} 空子句会保留旧 model/baseUrl 导致错配/漏换 key）
      update: { model: CONFIG.model, baseUrl: process.env.GLM_BASE_URL || 'https://opencode.ai/zen/go', apiKey: key },
      create: a,
    })
  }
}

/** P10（F3）：CLI 会把 provider 错误当正文返回（401 合成文本先例）——「非空白即通过」会把环境故障判成就绪。
 *  宁严勿松是 fail-closed 方向：preflight 正文本应只有「就绪」，命中签名即判环境不判模型。
 *  发射前复核 #4：数字 token 加词边界，防 latency/正文裸数字子串误伤。 */
export function detectPreflightError(text: string): string | null {
  const m = text.match(/\b(401|403|429)\b|rate[ -]?limit|too many requests|overloaded|quota|额度|余额|限流|过于频繁|unavailable|invalid api key|未返回有效内容|"error"\s*:/i)
  return m ? m[0] : null
}

/** P10 加固：耗时+key 指纹（非 key 本体）回显建立 R1 读分基线（走 console.log 进 .log，T6 Step0 抄录）；
 *  空文本/错误签名都 throw（快速失败不烧批）。返回 void——复核 #7：无消费方的字段不返回。 */
export async function preflightDecision(): Promise<void> {
  const { prisma } = await import('@/lib/db')
  const orch = await prisma.agent.findFirst({ where: { isOrchestrator: true } })
  if (!orch) throw new Error('preflight: 无 orchestrator agent')
  const key = process.env.GLM_API_KEY ?? ''
  const fingerprint8 = createHash('sha256').update(key).digest('hex').slice(0, 8)
  const { executeSingleAgent } = await import('@/lib/orchestrator')
  const t0 = Date.now()
  const { result } = await executeSingleAgent(
    { name: orch.name, systemPrompt: orch.systemPrompt, platform: orch.platform, model: orch.model, baseUrl: orch.baseUrl, apiKey: orch.apiKey },
    '只回复两个字：就绪', '', () => {},
  )
  const latencyMs = Date.now() - t0
  const reply = (result ?? '').slice(0, 60)
  console.log(`[preflight] model=${CONFIG.model} baseUrl=${orch.baseUrl} latency=${latencyMs}ms key#${fingerprint8} reply="${reply}"`)
  if (!result || !result.trim()) throw new Error(`preflight: LLM 返回空（latency=${latencyMs}ms, key#${fingerprint8}）——provider 未配好`)
  const sig = detectPreflightError(result)
  if (sig) throw new Error(`preflight: 回复含 provider 错误签名「${sig}」（latency=${latencyMs}ms, key#${fingerprint8}）——环境故障，不得进探带读数`)
}

/** 主入口：pilot beforeAll 调 */
export async function setupExperiment(): Promise<void> {
  // P9-乙 T5-1（ISSUE-013）：先清洗继承的 provider/session env（Gate 冒烟 401 根因：
  // 交互式会话的 ANTHROPIC_AUTH_TOKEN 等经 process.env 漏进 CLI 子进程与讯飞 key 并发型），
  // 再跑 F3 断言——CLAUDE_CONFIG_DIR 在清洗白名单豁免内，顺序不可倒置（setup.test 钉死）
  const scrubbed = scrubInheritedProviderEnv()
  if (scrubbed.length > 0) console.log(`[setup] 已清洗继承 env: ${scrubbed.join(', ')}`)
  // P9-乙 T4（F3）：CLI 子进程继承用户默认 CLAUDE_CONFIG_DIR 会挂死（P8 实证）——preflight 第一闸门，未隔离即拒跑
  assertCliConfigDir(process.env.CLAUDE_CONFIG_DIR)
  // P6 T9: 纯单测 import @/lib/orchestrator → @/lib/db 会让 prisma libsql 连接把 p5.db 切进 WAL 模式，
  // 且 vitest 模块运行器下 @libsql/client close() 不释放文件(EBUSY)——migrate deploy 子进程拿不到 p5.db 写锁(SQLite database error)。
  // 用同一连接把 journal_mode 切回 DELETE：触发 checkpoint 并删掉 wal/shm，连接转空闲 DELETE 模式，migrate 子进程即可写入。
  try {
    const { prisma } = await import('@/lib/db')
    await prisma.$executeRawUnsafe('PRAGMA journal_mode=DELETE')
    await prisma.$disconnect()
  } catch { /* 无 prisma 实例/未连接,lazy 下安全 */ }
  resetPrismaSingleton()
  initP5Db()
  await ensureExperimentAgents()
  await preflightDecision()
}

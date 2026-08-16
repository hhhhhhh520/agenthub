import { execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG } from './config'

const REPO_ROOT = join(__dirname, '..', '..')

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

/** preflight：1 次真实决策调用验证 CLI + provider 可用（默认 opencode.ai/zen/go + deepseek-v4-flash），失败快速失败不烧 30 次（Spec §7.2） */
export async function preflightDecision(): Promise<void> {
  const { prisma } = await import('@/lib/db')
  const orch = await prisma.agent.findFirst({ where: { isOrchestrator: true } })
  if (!orch) throw new Error('preflight: 无 orchestrator agent')
  // 走 executeSingleAgent 一次真实调用（deepseek-v4-flash），验证 spawn CLI + provider 配好
  const { executeSingleAgent } = await import('@/lib/orchestrator')
  const { result } = await executeSingleAgent(
    { name: orch.name, systemPrompt: orch.systemPrompt, platform: orch.platform, model: orch.model, baseUrl: orch.baseUrl, apiKey: orch.apiKey },
    '只回复两个字：就绪',
    '',
    () => {}
  )
  if (!result || !result.trim()) throw new Error('preflight: LLM 返回空，provider 未配好')
}

/** 主入口：pilot beforeAll 调 */
export async function setupExperiment(): Promise<void> {
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

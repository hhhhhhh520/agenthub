import { prisma } from '@/lib/db'
import { detectCLIPlatform } from '@/lib/cli-detect'

export async function getConfig(key: string): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ value: string }>>
    `SELECT value FROM AppConfig WHERE key = ${key}`
  return rows[0]?.value || ''
}

export async function setConfig(key: string, value: string): Promise<void> {
  await prisma.$executeRaw
    `INSERT OR REPLACE INTO AppConfig (key, value, updatedAt) VALUES (${key}, ${value}, datetime('now'))`
}

export async function isSetupCompleted(): Promise<boolean> {
  return await getConfig('setupCompleted') === 'true'
}

export async function getOrchestratorConfig(): Promise<{ apiKey: string; model: string; baseUrl: string }> {
  const rows = await prisma.$queryRaw<Array<{ key: string; value: string }>>
    `SELECT key, value FROM AppConfig WHERE key IN ('orchestrator_apiKey', 'orchestrator_model', 'orchestrator_baseUrl')`
  const config: Record<string, string> = {}
  for (const row of rows) {
    config[row.key] = row.value
  }
  return {
    apiKey: config.orchestrator_apiKey || '',
    model: config.orchestrator_model || '',
    baseUrl: config.orchestrator_baseUrl || '',
  }
}

/**
 * 确保 Orchestrator Agent 记录存在
 * 首次调用时从 AppConfig 迁移旧配置到 Agent 记录
 * 后续调用直接跳过（无 DB 开销）
 */
export async function ensureOrchestratorAgent(): Promise<void> {
  const existing = await prisma.agent.findFirst({ where: { isOrchestrator: true } })
  if (existing) return

  const config = await getOrchestratorConfig()
  const platform = detectCLIPlatform() || 'claude-code'

  try {
    await prisma.agent.create({
      data: {
        name: 'Orchestrator',
        expertise: '任务协调、智能编排、多Agent协作',
        systemPrompt: '你是 AgentHub 的 Orchestrator，负责任务协调和智能编排。',
        platform,
        model: config.model || '',
        baseUrl: config.baseUrl || '',
        apiKey: config.apiKey || '',
        isPreset: true,
        isOrchestrator: true,
        accentColor: '#3b82f6',
      },
    })
  } catch {
    // 唯一约束冲突（名称已存在），忽略
  }
}
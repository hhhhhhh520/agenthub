/**
 * ISSUE-027 受管 claude 配置目录的维护入口：收集当前全量配置并集 → sweep。
 *
 * active 集合两路来源（缺一不可，双审查 🟡）：
 * - Agent 表全行（用户可见的 agent 配置）
 * - getOrchestratorAgent() 解析结果——orchestrator 在 Agent 行 apiKey 为空时改用
 *   AppConfig/CC-Switch 凭据，不落 Agent 行，不并入则其在用目录会被周期性误删
 *
 * 调用契约：本函数内部任一数据源失败即整体抛出，调用方必须 catch 后放弃本轮 sweep
 * （active 集合不完整时删 = 宁漏勿错）。触发点：GET /api/agents 全量视图 + 启动兜底
 * （src/instrumentation.ts）——仅挂 UI 加载会让出清与 UI 访问脱钩（生命周期审查 🟡1.1）。
 */
import { tmpdir } from 'node:os'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { prisma } from '@/lib/db'
import { sweepAgentClaudeConfigDirs, claudeConfigDir } from '@/lib/adapter/claude-code-env'
import { opencodeCfgDirName } from '@/lib/adapter/opencode-adapter'
import { getOrchestratorAgent } from '@/lib/orchestrator'

export async function sweepWithCurrentConfigs(): Promise<string[]> {
  const cfgRows = await prisma.agent.findMany({ select: { id: true, baseUrl: true, apiKey: true, model: true } })
  const orchestrator = await getOrchestratorAgent()
  const dirs = [...cfgRows, orchestrator]
    .map(r => claudeConfigDir(r))
    .filter((d): d is string => d !== null)
  const removed = sweepAgentClaudeConfigDirs(dirs)
  removed.push(...sweepOrphanOpencodeXdgDirs(cfgRows.map(r => r.id)))
  return removed
}

function sweepOrphanOpencodeXdgDirs(activeAgentIds: string[]): string[] {
  const active = new Set(activeAgentIds.map(id => opencodeCfgDirName(id)))
  const out: string[] = []
  try {
    for (const e of readdirSync(tmpdir(), { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith('agenthub-oc-')) continue
      if (active.has(e.name.slice('agenthub-oc-'.length))) continue
      rmSync(join(tmpdir(), e.name), { recursive: true })
      out.push(e.name)
    }
  } catch { /* tmp unreadable: best-effort */ }
  return out
}

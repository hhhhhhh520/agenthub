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
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { prisma } from '@/lib/db'
import { sweepAgentClaudeConfigDirs, claudeConfigDir } from '@/lib/adapter/claude-code-env'
import { opencodeCfgDirName, OPENCODE_OWNER_FILE } from '@/lib/adapter/opencode-adapter'
import { processRegistry } from '@/lib/adapter/process-registry'
import { getOrchestratorAgent } from '@/lib/orchestrator'

// P2-11 Round 6: Adapter 先 mkdir 再发布 owner。无 marker 的新目录不能立刻
// 当历史孤儿删除；给初始化留出宽限期，超过后才按历史目录清理。
const OPENCODE_OWNER_PUBLISH_GRACE_MS = 24 * 60 * 60 * 1000

export async function sweepWithCurrentConfigs(): Promise<string[]> {
  const cfgRows = await prisma.agent.findMany({ select: { id: true, baseUrl: true, apiKey: true, model: true } })
  const orchestrator = await getOrchestratorAgent()
  const dirs = [...cfgRows, orchestrator]
    .map(r => claudeConfigDir(r))
    .filter((d): d is string => d !== null)
  const removed = sweepAgentClaudeConfigDirs(dirs)
  removed.push(...sweepOrphanOpencodeXdgDirs(
    cfgRows.map(r => r.id),
    processRegistry.getActiveManagedConfigDirs(),
  ))
  return removed
}

function sweepOrphanOpencodeXdgDirs(activeAgentIds: string[], activeManagedDirs: string[] = []): string[] {
  // 兼容历史 agent-only 目录；会话级目录由 ProcessRegistry 的存活 entry 精确保护。
  const active = new Set([
    ...activeAgentIds.map(id => opencodeCfgDirName(id)),
    ...activeManagedDirs.map(d => basename(d)),
  ])
  const out: string[] = []
  try {
    for (const e of readdirSync(tmpdir(), { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith('agenthub-oc-')) continue
      if (active.has(e.name)) continue
      // P2-11: owner PID 存活时（包括本进程）不能删。本进程 send 可能正处在
      // exit→retry backoff，registry 已删 entry 但 XDG 仍会被下一轮复用。
      // 无 marker 的新目录可能是另一实例刚 mkdir、尚未发布 owner；只有超过
      // 发布宽限期的历史目录才可清理。有 marker 但损坏/不可读不能作为
      // “已证明无人使用”的证据，先保留。
      if (mustPreserveOwnerDirectory(e.name)) continue
      rmSync(join(tmpdir(), e.name), { recursive: true })
      out.push(e.name)
    }
  } catch { /* tmp unreadable: best-effort */ }
  return out
}

function mustPreserveOwnerDirectory(dirName: string): boolean {
  let raw: string
  try {
    raw = readFileSync(join(tmpdir(), dirName, OPENCODE_OWNER_FILE), 'utf-8')
  } catch (err) {
    // 没有 owner marker：可能是历史 agent-only 目录，也可能是另一实例刚
    // mkdir、owner 尚未发布的新目录。新目录必须保留；只有超过宽限期的
    // 无 marker 目录才允许按历史孤儿清理。
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        const stat = statSync(join(tmpdir(), dirName))
        return Date.now() - stat.mtimeMs <= OPENCODE_OWNER_PUBLISH_GRACE_MS
      } catch {
        return true
      }
    }
    // 文件存在但读不了：不能证明 owner 已死，宁可不删。
    return true
  }

  let parsed: { pid?: unknown }
  try {
    parsed = JSON.parse(raw) as { pid?: unknown }
  } catch {
    return true // marker 损坏：不能作为可删证据
  }
  const pid = typeof parsed.pid === 'number' ? parsed.pid : NaN
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true // 包括 process.pid：本进程 retry 资源仍在使用
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

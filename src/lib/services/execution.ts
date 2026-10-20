import * as fs from 'fs'
import * as path from 'path'
import { prisma } from '@/lib/db'
import { executeTaskBatch, callLLMForAnalysis, executeSingleAgent, getOrchestratorAgent, type PriorTaskMeta } from '@/lib/orchestrator'
import { buildMonitoringPrompt } from '@/lib/orchestrator/prompts'
import { enforceFileOverlap } from '@/lib/orchestrator/scheduler'
import { getChangedFilesDetailed, getGitSnapshotDetailed, type GitEvidence } from './shadow-git'
import { pickSensitive } from './sensitive-paths'
import { invalidateCliSession } from './cli-session'
import type { AgentConfig } from '@/lib/adapter/types'
import { validateAgainstSchema } from './schema-validator'
import { structuredMonitorVerdict, describeSignal, isStructuredMonitorOn } from './structured-monitor'
import { isPreflightVerifyOn, detectVerifyCommands, runVerifyCommands } from './preflight-verify'
import { TimeoutError } from '@/lib/orchestrator/timeout'
import { transitionPhase, MAX_CORRECTION_RETRIES } from '@/lib/orchestrator/state-machine'
import { isSessionCancelled } from '@/lib/cancellation'
import type { SendEvent } from './review'

/** 路径归一化：统一斜杠为正斜杠,去除开头 ./,小写比较(Windows 不区分大小写) */
export const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()

function parseDeclaredFilesForAudit(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export type BatchAuditResult =
  | { status: 'unavailable'; reason: string }
  | { status: 'pass'; changedFiles: string[]; batchDeclared: string[]; batchUndeclared: string[] }
  | { status: 'violation'; changedFiles: string[]; batchDeclared: string[]; batchUndeclared: string[]; sensitiveViolations: string[] }

/**
 * 批次级文件审计：一次 diff 结果按“本批所有任务 declaredFiles 的并集”归责。
 *
 * - diff 读取失败 → unavailable，调用方必须整批失败且禁止发布 result/completed；
 * - 未声明的敏感路径 → violation，整批失败；
 * - 普通未声明文件 → pass + batchUndeclared（只告警，不删除共享目录文件）；
 * - 本批所有任务 declaredFiles 都为空 → 跳过文件校验（契约 §1.2 b）。
 */
export function auditBatchChanges(
  projectRoot: string,
  sessionId: string,
  before: Set<string> | GitEvidence,
  batchTasks: Array<{ declaredFiles: string }>,
): BatchAuditResult {
  const changed = getChangedFilesDetailed(projectRoot, sessionId, before)
  if (!changed.ok) return { status: 'unavailable', reason: changed.reason }

  const declaredByNorm = new Map<string, string>()
  for (const task of batchTasks) {
    for (const file of parseDeclaredFilesForAudit(task.declaredFiles)) {
      const norm = normalizePath(file)
      if (!declaredByNorm.has(norm)) declaredByNorm.set(norm, file)
    }
  }
  const batchDeclared = [...declaredByNorm.values()]
  const batchUndeclared = batchDeclared.length === 0
    ? []
    : changed.files.filter(f => !declaredByNorm.has(normalizePath(f)))
  const sensitiveViolations = pickSensitive(batchUndeclared)

  if (sensitiveViolations.length > 0) {
    return { status: 'violation', changedFiles: changed.files, batchDeclared, batchUndeclared, sensitiveViolations }
  }
  return { status: 'pass', changedFiles: changed.files, batchDeclared, batchUndeclared }
}

/**
 * 清理越界文件:删除不属于任何批次的文件,保留其他批次声明的文件。
 * 会原地清空 undeclared 数组(避免监控审查再次触发纠偏)。
 *
 * ⚠️ 仅限 AgentHub 管理的隔离工作区使用；共享 projectDir 严禁调用（会误删
 * 用户/其他会话的真实文件）。当前生产执行路径已改为“只告警、不删除”，
 * 本函数仅保留给未来的隔离工作区实现与既有单测。
 *
 * @returns cleanedCount: 已清理文件数, protectedCount: 受保护文件数
 */
export function cleanupUndeclared(
  undeclared: string[],
  otherDeclaredFiles: string[],
  projectRoot: string,
): { cleanedCount: number; protectedCount: number } {
  const otherDeclared = new Set(otherDeclaredFiles.map(normalizePath))
  let cleanedCount = 0
  let protectedCount = 0

  for (const file of undeclared) {
    if (otherDeclared.has(normalizePath(file))) {
      protectedCount++
    } else {
      const fullPath = path.join(projectRoot, file)
      try {
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath)
          cleanedCount++
        }
      } catch (e) {
        console.warn(`[越界清理] 无法删除 ${file}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  // 清空 undeclared，避免监控审查再次看到越界文件触发纠偏重试
  undeclared.splice(0)
  return { cleanedCount, protectedCount }
}

interface TraceEntry {
  ts: string
  event: 'start' | 'error' | 'retry' | 'success' | 'blocked' | 'correction' | 'monitor' | 'preflight' | 'audit_unavailable'
  agent?: string
  message?: string
  attempt?: number
  duration_ms?: number
}

function appendTrace(existing: string, entry: TraceEntry): string {
  try {
    const arr = JSON.parse(existing || '[]')
    arr.push(entry)
    return JSON.stringify(arr)
  } catch {
    return JSON.stringify([entry])
  }
}

/** §3.2 条件写失败后的状态同步：重读 DB 真值回填内存（best-effort，不击穿批次循环） */
async function syncTaskStatusFromDb(task: { id: string; status: string }): Promise<void> {
  try {
    const fresh = await prisma.task.findUnique({ where: { id: task.id }, select: { status: true } })
    if (fresh) task.status = fresh.status
  } catch (err) {
    console.warn(`[execution] 任务 ${task.id} 状态重读失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function handleExecution(
  message: string,
  sessionId: string,
  agents: AgentConfig[],
  sendEvent: SendEvent,
  orchSessionId?: string,
  globalDeadline?: number
) {
  const tasks = await prisma.task.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  })

  if (tasks.length === 0) {
    sendEvent({ agentId: 'orchestrator', type: 'error', content: '没有待执行的任务' })
    return
  }

  if (isSessionCancelled(sessionId)) {
    sendEvent({ agentId: 'orchestrator', type: 'text', content: '执行已停止' })
    sendEvent({ agentId: 'orchestrator', type: 'done', content: '执行已停止' })
    return
  }

  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  const projectRoot = session?.projectDir && session.projectDir.trim()
    ? session.projectDir.trim()
    : process.cwd()

  const scheduledTasks = tasks.map(t => ({
    id: t.id,
    description: t.description,
    assignedAgent: agents.find(a => a.id === t.assignedAgentId)?.name || '',
    dependencies: JSON.parse(t.dependencies || '[]') as string[],
    declaredFiles: JSON.parse(t.declaredFiles || '[]') as string[],
    batch: 0,
  }))
  enforceFileOverlap(scheduledTasks)

  for (const st of scheduledTasks) {
    const task = tasks.find(t => t.id === st.id)
    if (task) {
      const currentDeps = JSON.stringify(st.dependencies)
      if (currentDeps !== task.dependencies) {
        await prisma.task.update({ where: { id: st.id }, data: { dependencies: currentDeps } })
        task.dependencies = currentDeps
      }
    }
  }

  // 读取 SessionMember 的 cliSessionId，用于首次执行时 fallback
  const sessionMembers = await prisma.sessionMember.findMany({
    where: { sessionId },
    select: { agentId: true, cliSessionId: true },
  })
  const memberSessionMap = new Map(sessionMembers.map(m => [m.agentId, m.cliSessionId]))

  // contract v1 §1.1: 从 DB 读取跨批权威 result（已完成 task 的交付物）
  // 重启后或前批已完成时，新批次依赖任务能从这里查到上游交付物
  const allResults = new Map<string, string>()
  // contract v1 §1.1: 同步保存所有 task 的 description + outputSchema 元数据，
  // 用于下游 prompt 的 <dependency name="..." output_schema="..."> 标签注入
  const allTaskMeta = new Map<string, PriorTaskMeta>()
  for (const t of tasks) {
    allTaskMeta.set(t.id, { description: t.description, outputSchema: t.outputSchema ?? undefined })
    if (t.status === 'completed' && t.result) {
      allResults.set(t.id, t.result)
    }
  }
  let hasProgress = true
  // P2: 外层循环上限随 correction 上限联动——单任务最坏 = 初跑 + MAX_CORRECTION_RETRIES 次纠偏
  // + 1 次熔断判定。旧 max 2 用 *3，放宽到 max 3 后 *3 会在第 3 轮截断第 4 轮熔断判定，
  // 导致熔断消息死代码、任务滞留 pending 下次再烧一次执行（审查抓出）。
  const MAX_ITERATIONS = tasks.length * (MAX_CORRECTION_RETRIES + 1)
  let iteration = 0

  const deadline = globalDeadline ?? Date.now() + 50 * 60 * 1000
  let cancelled = false

  /**
   * 取消时把本批未落地任务退回 pending：agent 结果可能只写了一半（进程被杀），
   * 不能发布 completed；发 task_status 让前端任务板立即回退，用户可续跑/redo。
   */
  const resetBatchToPending = async (batchTasks: Array<{ id: string; status: string }>) => {
    for (const task of batchTasks) {
      if (task.status === 'completed') continue
      const reset = await prisma.task.updateMany({
        where: { id: task.id, status: { in: ['in_progress', 'failed'] } },
        data: { status: 'pending' },
      })
      if (reset.count > 0) {
        task.status = 'pending'
        sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId: task.id, status: 'pending' }) })
      } else {
        await syncTaskStatusFromDb(task)
      }
    }
  }

  type ExecutionTask = (typeof tasks)[number]

  /** 依赖失败级联：只把仍为 pending 的任务置 blocked（§3.2 B4 条件写）。 */
  const cascadeBlockedTasks = async () => {
    for (const task of tasks) {
      if (task.status !== 'pending') continue
      const deps: string[] = JSON.parse(task.dependencies || '[]')
      const hasFailedDep = deps.some(depId => {
        const dep = tasks.find(t2 => t2.id === depId)
        return dep?.status === 'failed'
      })
      if (!hasFailedDep) continue
      const blockedTrace = appendTrace(task.trace || '[]', {
        ts: new Date().toISOString(), event: 'blocked', message: '依赖任务失败',
      })
      const blocked = await prisma.task.updateMany({ where: { id: task.id, status: 'pending' }, data: { status: 'blocked', trace: blockedTrace } })
      if (blocked.count === 0) { await syncTaskStatusFromDb(task); continue }
      task.status = 'blocked'
      task.trace = blockedTrace
      sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId: task.id, status: 'blocked' }) })
    }
  }

  /**
   * 审计失败统一收敛：本批任务全部 failed，不写 result、不发 completed、不跑监控。
   * - unavailable：基础设施失败，保留 cliSessionId（修好后可复用会话重试）
   * - sensitive：契约 §1.3 动作 7，清 cliSessionId，避免 agent 错误信念污染后续任务
   */
  const failBatchForAudit = async (
    batch: ExecutionTask[],
    message: string,
    mode: 'unavailable' | 'sensitive',
    expectedStatus: 'pending' | 'in_progress',
  ) => {
    for (const task of batch) {
      const trace = appendTrace(task.trace || '[]', mode === 'sensitive'
        ? { ts: new Date().toISOString(), event: 'error', message }
        : { ts: new Date().toISOString(), event: 'audit_unavailable', message })

      if (mode === 'sensitive') {
        const inv = await invalidateCliSession({
          taskId: task.id,
          sessionId,
          agentId: task.assignedAgentId,
          expectedFrom: expectedStatus,
          taskData: { status: 'failed', trace },
        })
        if (!inv.applied) {
          await syncTaskStatusFromDb(task)
          continue
        }
        if (task.assignedAgentId) memberSessionMap.set(task.assignedAgentId, null)
      } else {
        const failed = await prisma.task.updateMany({
          where: { id: task.id, status: expectedStatus },
          data: { status: 'failed', trace },
        })
        if (failed.count === 0) {
          await syncTaskStatusFromDb(task)
          continue
        }
      }

      task.status = 'failed'
      task.trace = trace
      sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId: task.id, status: 'failed' }) })
    }

    try {
      await prisma.message.create({ data: { role: 'orchestrator', rawContent: message, sessionId } })
    } catch (err) {
      console.warn(`[execution] 审计失败消息落库失败: ${err instanceof Error ? err.message : String(err)}`)
    }
    sendEvent({ agentId: 'orchestrator', type: 'text', content: message })
  }

  while (hasProgress && iteration < MAX_ITERATIONS) {
    if (isSessionCancelled(sessionId)) {
      cancelled = true
      break
    }
    if (Date.now() > deadline) {
      console.error('[TIMEOUT] handleExecution 全局耗时超限')
      sendEvent({ agentId: 'orchestrator', type: 'error', content: '执行阶段超时，部分任务未完成' })
      break
    }
    iteration++
    hasProgress = false

    // ISSUE-008 审查整改: blocked 任务在其依赖全部 completed 后自动复活为 pending。
    // 场景: 链式依赖 A→C, verify deps=[A,B,C]。A 失败 → C/verify 被置 blocked;
    // redo A 时 redo route 用一次性快照解锁下游,快照里 C 仍 blocked → verify 的
    // otherDepsOk 不满足被漏解锁。若此处不复活,verify 永久滞留 blocked 而 phase
    // 照常进 done(复现"完成但未验证")。每轮重查依赖,补齐即复活,通用修复所有同类滞留。
    for (const task of tasks) {
      if (task.status !== 'blocked') continue
      const reviveDeps: string[] = JSON.parse(task.dependencies || '[]')
      if (reviveDeps.length > 0 && reviveDeps.every(depId => tasks.find(t2 => t2.id === depId)?.status === 'completed')) {
        // §3.2 B5: 条件写——复活仅在仍为 blocked 时成立（他人已转移则弃权）
        const revived = await prisma.task.updateMany({ where: { id: task.id, status: 'blocked' }, data: { status: 'pending' } })
        if (revived.count === 0) continue
        task.status = 'pending'
        sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId: task.id, status: 'pending' }) })
      }
    }

    const readyTasks = tasks.filter(t => {
      if (t.status !== 'pending') return false
      const deps: string[] = JSON.parse(t.dependencies || '[]')
      return deps.every(depId => {
        const dep = tasks.find(t2 => t2.id === depId)
        return dep?.status === 'completed'
      })
    })

    if (readyTasks.length === 0) break

    // 批次开始快照：三态读取。失败时本批不执行、任务 failed、下游 blocked；
    // 绝不把 git 失败当成“没有改动”继续跑（否则审计形同虚设）。
    const snapshot = getGitSnapshotDetailed(projectRoot, sessionId)
    if (!snapshot.ok) {
      await failBatchForAudit(
        readyTasks,
        `[审计不可用] 批次开始影子 git 快照失败：${snapshot.reason}。本批任务未执行，已置 failed，可 redo。`,
        'unavailable',
        'pending',
      )
      await cascadeBlockedTasks()
      break
    }
    // 批次开始的内容证据（路径 → hash/null）：结束审计按内容差异归责，
    // 不再按“脏路径是否新出现”判断，覆盖已脏同一路径再次修改与忽略 .env。
    const gitBefore = snapshot.evidence

    // §3.2 B1: 互斥闸门——pending→in_progress 条件写。双流并发（abort 释放锁后的僵尸流 + 新流）
    // 时后到者 count=0 被剔除出批：同一任务同时只有一个执行流，重复执行结构性不可能。
    const batchTasks: typeof readyTasks = []
    for (const task of readyTasks) {
      const startTrace = appendTrace(task.trace || '[]', {
        ts: new Date().toISOString(), event: 'start', agent: agents.find(a => a.id === task.assignedAgentId)?.name,
      })
      const mark = await prisma.task.updateMany({ where: { id: task.id, status: 'pending' }, data: { status: 'in_progress', trace: startTrace } })
      if (mark.count === 0) {
        // 条件写失败：状态已被其他写者转移（GET stuck reset / 另一执行流）。重读同步内存后弃权。
        await syncTaskStatusFromDb(task)
        console.warn(`[execution] 任务 ${task.id} 标记 in_progress 失败（状态已被其他写者转移，当前=${task.status}），本批剔除`)
        continue
      }
      task.status = 'in_progress'
      task.trace = startTrace
      batchTasks.push(task)
      sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId: task.id, status: 'in_progress' }) })
    }

    // Heartbeat: update updatedAt every 60s to prevent stuck task reset
    const heartbeats = new Map<string, NodeJS.Timeout>()
    for (const task of batchTasks) {
      const heartbeat = setInterval(async () => {
        try { await prisma.task.update({ where: { id: task.id }, data: { updatedAt: new Date() } }) }
        catch {}
      }, 60_000)
      heartbeats.set(task.id, heartbeat)
    }

    let results: Map<string, { result: string; sessionId?: string }>
    let batchFailedIds: string[] = []
    let batchFailedReasons: Record<string, string> = {}
    // P0 重放 bug 修复: executeTaskBatch 预装的历史任务 id(非本批新执行)。
    // success 处理循环必须跳过它们,否则 redo/续跑/多批执行会重跑旧任务的
    // monitoring LLM + 重复写 DB message + 覆盖 trace/correctionCount,
    // 甚至被审查 LLM 置回 pending 触发无界重执行(见 A方向规划 3.3 主修法)
    let preloadedIds = new Set<string>()
    try {
      // §3.2 B1: 全部任务被互斥闸门剔除时不发起批次执行（另一流正在执行这些任务）
      if (batchTasks.length === 0) {
        results = new Map()
      } else {
      const batchOutcome = await executeTaskBatch(
        batchTasks.map(t => {
          // P1: 纠偏重试时注入越界信息
          let desc = t.description
          if (t.correctionCount > 0) {
            const trace = JSON.parse(t.trace || '[]') as Array<{ event?: string; message?: string }>
            const last = trace.filter(tr => tr.event === 'correction').pop()
            if (last?.message) desc = `[上次问题] ${last.message}\n请避免重复此错误。\n\n${desc}`
          }
          return {
            id: t.id,
            description: desc,
            assignedAgent: agents.find(a => a.id === t.assignedAgentId)?.name || '',
            dependencies: JSON.parse(t.dependencies || '[]'),
            declaredFiles: JSON.parse(t.declaredFiles || '[]'),
            batch: 0,
          }
        }),
        agents.map(a => {
          const task = tasks.find(t => t.assignedAgentId === a.id)
          return {
            id: a.id,
            name: a.name,
            systemPrompt: a.systemPrompt,
            platform: a.platform,
            model: a.model || undefined,
            baseUrl: a.baseUrl,
            apiKey: a.apiKey,
            // 优先用任务级 sessionId，fallback 到对齐阶段的 SessionMember sessionId
            sessionId: task?.cliSessionId || memberSessionMap.get(a.id) || undefined,
            permissionMode: session?.permissionMode || 'default',
          }
        }),
        (taskId, chunk) => sendEvent({ agentId: taskId, type: chunk.type, content: chunk.content, data: chunk.data }),
        sessionId,
        projectRoot,
        allResults,  // contract v1 §1.1: 跨批权威 result
        allTaskMeta  // contract v1 §1.1: 跨批 task 元数据（description + outputSchema）
      )
      results = batchOutcome.results
      batchFailedIds = batchOutcome.failedTaskIds
      batchFailedReasons = batchOutcome.failedTaskReasons ?? {}
      preloadedIds = new Set(batchOutcome.preloadedIds ?? [])
      }
    } catch (err) {
      for (const task of batchTasks) {
        const failTrace = appendTrace(task.trace || '[]', {
          ts: new Date().toISOString(), event: 'error', message: err instanceof Error ? err.message : 'Task batch execution failed',
        })
        // §3.2 B3: 条件写——仅当任务仍在本流 in_progress 时成立
        const failed = await prisma.task.updateMany({ where: { id: task.id, status: 'in_progress' }, data: { status: 'failed', trace: failTrace } })
        if (failed.count === 0) {
          console.warn(`[execution] 任务 ${task.id} failed 条件写失败（状态已被其他写者转移），弃权`)
          await syncTaskStatusFromDb(task)
          continue
        }
        task.status = 'failed'
        sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId: task.id, status: 'failed' }) })
      }
      results = new Map()
    } finally {
      // Clear all heartbeats
      for (const heartbeat of heartbeats.values()) {
        clearInterval(heartbeat)
      }
    }

    // 取消可能发生在批次执行中（进程已被 kill，results 可能是半成品）。
    // 先退回 pending，绝不把半成品当 completed 发布。
    if (isSessionCancelled(sessionId)) {
      await resetBatchToPending(batchTasks)
      cancelled = true
      break
    }

    for (const taskId of batchFailedIds) {
      const task = tasks.find(t => t.id === taskId)
      if (task && task.status !== 'failed') {
        // ISSUE-011 F1: 透传真实失败原因,不再写死通用串(?? 保留空串真实原因,不被 || 吞掉)
        const failReason = batchFailedReasons[taskId] ?? 'Task failed in batch execution'
        const failTrace = appendTrace(task.trace || '[]', {
          ts: new Date().toISOString(), event: 'error', message: failReason,
        })
        // §3.2 B3: 条件写——仅当任务仍在本流 in_progress 时成立
        const failed = await prisma.task.updateMany({ where: { id: taskId, status: 'in_progress' }, data: { status: 'failed', trace: failTrace } })
        if (failed.count === 0) {
          console.warn(`[execution] 任务 ${taskId} failed 条件写失败（状态已被其他写者转移），弃权`)
          await syncTaskStatusFromDb(task)
          continue
        }
        task.status = 'failed'
        task.trace = failTrace  // 内存同步,与 DB 一致(失败任务 trace 供后续读取时不留缺 error 事件的旧值)
        sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId, status: 'failed' }) })
        // ISSUE-011 F1: SSE + 聊天历史都落真实原因(此前 trace/SSE 全丢,只能看服务日志;
        // 只发 SSE 会被结尾 done 事件刷掉 streaming buffer,故同步 message.create 持久化)
        const failMsg = `任务 ${taskId} 失败: ${failReason}`
        await prisma.message.create({ data: { role: 'orchestrator', rawContent: failMsg, sessionId } })
        sendEvent({ agentId: 'orchestrator', type: 'text', content: failMsg })
      }
    }

    // 批次级审计：在任何 task 写 completed/result 之前完成。
    // unavailable / 敏感越界 → 整批 failed，绝不发布成功；普通越界只告警，绝不删共享目录文件。
    let batchChangedFiles: string[] = []
    let batchDeclared: string[] = []
    let batchUndeclared: string[] = []
    if (batchTasks.length > 0) {
      const audit = auditBatchChanges(projectRoot, sessionId, gitBefore, batchTasks)
      if (audit.status === 'unavailable') {
        await failBatchForAudit(
          batchTasks,
          `[审计不可用] 批次结束 diff 读取失败：${audit.reason}。本批结果未发布，任务已置 failed，可 redo。`,
          'unavailable',
          'in_progress',
        )
        await cascadeBlockedTasks()
        break
      }
      if (audit.status === 'violation') {
        await failBatchForAudit(
          batchTasks,
          `[敏感路径越界] 本批未声明修改了敏感文件：${audit.sensitiveViolations.join(', ')}。整批任务失败，未发布 result。`,
          'sensitive',
          'in_progress',
        )
        await cascadeBlockedTasks()
        break
      }

      batchChangedFiles = audit.changedFiles
      batchDeclared = audit.batchDeclared
      batchUndeclared = audit.batchUndeclared
      if (batchUndeclared.length > 0) {
        const warningMsg = `[越界警告] 本批修改了未声明文件：${batchUndeclared.join(', ')}。共享项目目录不自动删除，请人工确认。`
        await prisma.message.create({ data: { role: 'orchestrator', rawContent: warningMsg, sessionId } })
        sendEvent({ agentId: 'orchestrator', type: 'text', content: warningMsg })
      }
    }

    for (const [taskId, { result, sessionId: cliSessionId }] of results) {
      if (isSessionCancelled(sessionId)) {
        await resetBatchToPending(batchTasks)
        cancelled = true
        break
      }
      // P0 重放 bug 修复: 跳过 executeTaskBatch 预装的历史任务(非本批新执行)。
      // 旧代码无此守卫,对已完成任务也重走完整 success 处理(见上方 preloadedIds 注释)
      if (preloadedIds.has(taskId)) continue
      const taskForTrace = tasks.find(t => t.id === taskId)

      // 批次级归责：敏感路径已在批次审计统一处理；这里只保留本任务声明范围，
      // 用于完成消息/监控 prompt 的“真实交集”，不再逐任务拿 batch diff 判敏感。
      const declaredFiles: string[] = JSON.parse(taskForTrace?.declaredFiles || '[]')
      const normalizedDeclared = declaredFiles.map(normalizePath)

      const successTrace = appendTrace(taskForTrace?.trace || '[]', {
        ts: new Date().toISOString(), event: 'success',
      })
      // contract v1 §1.1: 持久化 result 到 DB,作为跨批权威载体
      // ⚠️-C3 修复:CLI 本次没吐 session chunk 时,不动 cliSessionId(保留旧值)
      // 而不是用 null 覆盖。与 contract v1 §1.3 "正常完成保留 cliSessionId(沿用历史是好的)"对齐。
      // 只有 ❌-1/纠偏路径才主动清 cliSessionId
      //
      // F10 修复:task + SessionMember 两表更新包事务,保持 ⚠️-C2 一致性
      // (C2 只修了 failure/correction 路径,success 路径同源风险被遗漏 — review 抓出)
      const successAgentId = taskForTrace?.assignedAgentId
      // §3.2 B2: completed 条件写 + member 联动（交互式事务）——仅当任务仍在本流
      // in_progress 时完成写才成立；count=0（被 GET stuck reset / 其他流转移）→ 弃权：
      // result 不落库、member 不写（防"任务被拒但 member 记了新 session"的脏 fallback，
      // 正是动作 7 防的状态污染方向）。
      let completed = true
      await prisma.$transaction(async (tx) => {
        const res = await tx.task.updateMany({
          where: { id: taskId, status: 'in_progress' },
          data: {
            status: 'completed',
            correctionCount: 0,
            trace: successTrace,
            result,
            ...(cliSessionId ? { cliSessionId } : {}),
          },
        })
        if (res.count === 0) {
          completed = false
          return
        }
        if (cliSessionId && successAgentId) {
          await tx.sessionMember.updateMany({
            where: { sessionId, agentId: successAgentId },
            data: { cliSessionId },
          })
        }
      })
      if (!completed) {
        console.warn(`[execution] 任务 ${taskId} completed 条件写失败（状态已被其他写者转移），弃权本次结果与 monitoring`)
        if (taskForTrace) await syncTaskStatusFromDb(taskForTrace)
        continue
      }
      // 只有 completed 条件写成功后才发布到权威结果 Map：count=0 的结果不得进入
      // 后续批次入参、完成摘要或 done 帧。
      allResults.set(taskId, result)
      if (taskForTrace) taskForTrace.result = result
      // 内存 trace 同步（对齐失败路径 :323 先例）——completed 写携带 successTrace 落库，
      // 不同步会让后续 monitor 埋点/纠偏以过期内存 trace 为基串，覆盖丢失 success 事件（审查抓出）
      if (taskForTrace) taskForTrace.trace = successTrace
      // 同步 sessionId 到内存 memberSessionMap,供后续任务 fallback(事务外纯内存)
      if (cliSessionId && successAgentId) {
        memberSessionMap.set(successAgentId, cliSessionId)
      }
      const task = tasks.find(t => t.id === taskId)
      if (task) task.status = 'completed'
      sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId, status: 'completed' }) })
      hasProgress = true

      // 声明交集（declared∩changed，normalized 口径）：完成消息与监控 prompt 审计共用。
      // 监控 prompt 的"实际修改的声明文件"必须填真实交集而非声明清单——
      // 谎报会让审查 LLM 对 ghost 类缺陷（声称完成但声明文件未动）系统性漏检（monitor A/B 安全审查发现）
      // ISSUE-011 F3: 完成消息只列“本任务声明且实际变更”的文件；batch diff
      // 含同批其他任务的文件，不能串报给无声明任务。
      const attributed = batchChangedFiles.filter(f => normalizedDeclared.includes(normalizePath(f)))
      const fileNote = attributed.length > 0 ? `,修改了 ${attributed.join(', ')}` : ''
      sendEvent({ agentId: 'orchestrator', type: 'text', content: `任务 ${taskId} 完成${fileNote}` })

      // contract v1 §1.2 a (动作 5,降级版): outputSchema 软校验
      // 不影响任务状态,只在缺字段/缺 JSON 块时发警告
      const schemaCheck = validateAgainstSchema(result, taskForTrace?.outputSchema)
      if (!schemaCheck.valid) {
        await prisma.message.create({ data: { role: 'orchestrator', rawContent: schemaCheck.message, sessionId } })
        sendEvent({ agentId: 'orchestrator', type: 'text', content: schemaCheck.message })
      }

      // §3.4: 结构化监控信号判定（S1 git-truth 完成性 + S2 outputSchema）——纯函数。
      // 信号命中 → Task.trace 记 event:'monitor'（低频埋点，on/off 都记：
      // on 臂给纠偏触发样本、未设臂给反事实样本，对比数据由此聚合，三梯队第 1 项）。
      // 基底用 successTrace（B2 落库现值）——内存 taskForTrace.trace 在 completed 写后
      // 未同步过 success 事件，用内存值做基串会把 DB trace 覆盖成缺 success 的版本（审查抓出）。
      // S1 用批次声明并集：逐任务拿 batch diff 比较会把“同批别的任务改了该文件”
      // 误判成本任务 ghost（A 声明 package.json、B 只声明 foo.ts 的已知误报）。
      // 本任务 declaredFiles 为空时 S1 不参与（纯讨论/文档任务没有文件产出声明）。
      const structured = structuredMonitorVerdict({
        declaredFiles: declaredFiles.length > 0 ? batchDeclared : [],
        changedFiles: batchChangedFiles,
        schemaCheck,
      })
      if (structured.signals.length > 0) {
        const monitorTrace = appendTrace(successTrace, {
          ts: new Date().toISOString(), event: 'monitor',
          message: structured.signals.map(describeSignal).join('；'),
        })
        // §3.2 B2 纪律：trace 追加仅当 completed 写仍成立（他人已转移则弃权埋点）
        const traced = await prisma.task.updateMany({ where: { id: taskId, status: 'completed' }, data: { trace: monitorTrace } })
        if (traced.count === 0) {
          console.warn(`[execution] 任务 ${taskId} monitor 埋点被条件写拦下（状态已被其他写者转移），弃权`)
        } else if (taskForTrace) {
          taskForTrace.trace = monitorTrace
        }
      }

      // §3.4: 纠偏统一助手——结构化触发与 LLM 触发共用同一纠偏路径
      // （消息可见 + correctionTrace + invalidateCliSession 统一入口 + hasProgress）
      const applyCorrection = async (correctionNote: string): Promise<void> => {
        const correctionMsg = `Orchestrator 纠偏：任务 "${task?.description}" ${correctionNote}`
        await prisma.message.create({ data: { role: 'orchestrator', rawContent: correctionMsg, sessionId } })
        sendEvent({ agentId: 'orchestrator', type: 'text', content: correctionMsg })

        const retryCount = task?.correctionCount ?? 0
        // P2: max 2 → MAX_CORRECTION_RETRIES(3)，与 review.ts 委派路径合一（§5.4）
        if (retryCount < MAX_CORRECTION_RETRIES) {
          const correctionTrace = appendTrace(task?.trace || '[]', {
            ts: new Date().toISOString(), event: 'correction', message: correctionNote, attempt: retryCount + 1,
          })
          // contract v1 §1.3 P0 (动作 7): 纠偏退回 pending 时清 cliSessionId
          // task.result 即将被推翻重写,agent 历史里"我做对了"的认知是脏数据,起新 session 重来
          // (两表事务语义由统一入口 invalidateCliSession 承载,roadmap §2.4)
          // §3.2 B6: expectedFrom='completed' 前置——僵尸流的晚到纠偏写不得覆盖
          // 新流已推进的状态（新流已把任务 redo 后推进时，条件写不匹配 → 弃权）
          const agentId = taskForTrace?.assignedAgentId
          const inv = await invalidateCliSession({
            taskId,
            sessionId,
            agentId,
            expectedFrom: 'completed',
            taskData: { status: 'pending', correctionCount: retryCount + 1, trace: correctionTrace },
          })
          if (!inv.applied) {
            console.warn(`[execution] 任务 ${taskId} 纠偏退回被条件写拦下（状态已被其他写者转移），弃权`)
            if (task) await syncTaskStatusFromDb(task)
          } else {
            // 纠偏把任务退回 pending 后，原先的完成结果不再是权威交付物；
            // 从 allResults 移除，避免重试失败/取消时摘要仍发布旧结果。
            allResults.delete(taskId)
            if (agentId) memberSessionMap.set(agentId, null)
            if (task) { task.status = 'pending'; task.correctionCount = retryCount + 1; task.trace = correctionTrace; task.cliSessionId = null }
            sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId, status: 'pending', retryCount: retryCount + 1 }) })
            hasProgress = true
          }
        } else {
          sendEvent({ agentId: 'orchestrator', type: 'text', content: `任务 "${task?.description}" 纠偏重试已达上限(${MAX_CORRECTION_RETRIES}次)，保持完成状态` })
        }
      }

      // 取消后不再跑监控/纠偏/预检，避免已经停止的批次继续产生副作用。
      if (isSessionCancelled(sessionId)) {
        await resetBatchToPending(batchTasks)
        cancelled = true
        break
      }

      // §3.4: 结构化监控已转正为生产默认（2026-09-27，未设=on）——结构化 correction 直接触发纠偏
      // （LLM 降级第二道）；结构化 pass 或显式 'off'（逃生门）→ LLM 审查照跑
      if (isStructuredMonitorOn() && structured.verdict === 'correction') {
        // 遏制与 LLM 臂对称：纠偏途中 prisma 异常不穿透 handleExecution（否则 SSE 断流、
        // 剩余任务处理全部放弃、任务滞留 in_progress 等 stuck reset）
        try {
          await applyCorrection(structured.signals.map(describeSignal).join('；'))
        } catch (err) {
          if (err instanceof TimeoutError) console.error('[TIMEOUT] structured monitoring', taskId)
          /* structured monitoring correction failed, continue */
        }
      } else {
        try {
          const monitoringPrompt = buildMonitoringPrompt(task?.description || '', result, declaredFiles, { declared: attributed, undeclared: batchUndeclared }, 'batch', projectRoot)
          const orch = await getOrchestratorAgent()
          const MONITORING_TIMEOUT_MS = 2 * 60 * 1000
          const { result: reviewResult } = await Promise.race([
            executeSingleAgent(
            {
              name: 'Orchestrator',
              systemPrompt: '你是代码审查专家，负责检查 Agent 输出质量。返回 JSON 格式的审查结果。',
              platform: orch.platform,
              model: orch.model || undefined,
              baseUrl: orch.baseUrl || undefined,
              apiKey: orch.apiKey || undefined,
              sessionId: orchSessionId,
              workDir: projectRoot,
              permissionMode: 'auto',
              id: orch.id,
            },
            monitoringPrompt,
            '',
            () => {},
            sessionId,
            projectRoot
          ),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new TimeoutError(MONITORING_TIMEOUT_MS, 'monitoring')), MONITORING_TIMEOUT_MS)
            ),
          ])
          const cleaned = reviewResult.replace(/```json?\s*([\s\S]*?)```/, '$1').trim()
          const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
          if (jsonMatch) {
            const review = JSON.parse(jsonMatch[0])
            if (review.needsCorrection && review.correctionNote) {
              await applyCorrection(review.correctionNote)
            }
          }
        } catch (err) {
          if (err instanceof TimeoutError) console.error('[TIMEOUT] monitoring', taskId)
          /* monitoring failed, continue */
        }
      }

      // §3.4 S3: preflight 命令红绿灯（1A/2A/3A 拍板，2026-09-22）——约定探测 package.json
      // scripts.{test,build,lint}，`npm run <key>` 执行：命令头与参数均由白名单常量构造，
      // script 内容不进参数（npm 自身 shell 执行，信任边界=项目作者）；Windows npm 为 .cmd shim
      // 必须 shell 执行，注入面由 来源钉死(1A)+键白名单+assertVerifyKey 三层收口。
      // exit≠0 仅记 event:'preflight' 采数据（3A：不纠偏）。门控 EXPERIMENT_PREFLIGHT_VERIFY=on
      // （生产默认未设，roadmap §6）。被纠偏置 pending 的任务跳过——重做后会有新 completion 再采。
      if (isPreflightVerifyOn() && taskForTrace?.status === 'completed') {
        try {
          const keys = await detectVerifyCommands(projectRoot)
          if (keys.length > 0) {
            const outcomes = await runVerifyCommands(projectRoot, keys)
            const pfTrace = appendTrace(taskForTrace.trace || '[]', {
              ts: new Date().toISOString(), event: 'preflight',
              message: outcomes.map(o => `npm run ${o.key} → ${o.status}${o.exitCode !== undefined ? ` (exit ${o.exitCode})` : ''} (${o.durationMs}ms)`).join('；'),
            })
            const tracedPf = await prisma.task.updateMany({ where: { id: taskId, status: 'completed' }, data: { trace: pfTrace } })
            if (tracedPf.count === 0) {
              console.warn(`[execution] 任务 ${taskId} preflight 埋点被条件写拦下（状态已被其他写者转移），弃权`)
            } else {
              taskForTrace.trace = pfTrace
            }
          }
        } catch (err) {
          // 采集失败不穿透 handleExecution（同监控遏制先例——SSE 断流/剩余任务放弃代价更高）
          console.warn(`[execution] 任务 ${taskId} preflight 采集失败（不穿透）: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    await cascadeBlockedTasks()
  }

  // 取消是终止语义：不 auto-done、不发布成功总结；已完成任务保留，未完成退回 pending。
  if (cancelled || isSessionCancelled(sessionId)) {
    const stoppedMsg = '执行已停止。已完成的任务保留，未完成任务已退回 pending，可再次执行或 redo。'
    await prisma.message.create({ data: { role: 'orchestrator', rawContent: stoppedMsg, sessionId } })
    sendEvent({ agentId: 'orchestrator', type: 'text', content: stoppedMsg })
    sendEvent({ agentId: 'orchestrator', type: 'done', content: '执行已停止' })
    return
  }

  if (iteration >= MAX_ITERATIONS) {
    sendEvent({ agentId: 'orchestrator', type: 'error', content: '执行循环超过安全上限，已终止' })
  }

  const allDone = tasks.every(t => t.status === 'completed' || t.status === 'blocked')
  if (allDone) {
    await transitionPhase(sessionId, 'done')
  }

  // ISSUE-011 F2: 部分失败/遗留时诚实收尾,不静默停在 execution。
  // 此前批次失败后 phase 停 execution、pending 永久遗留无任何提示(实测 task6 README)。
  const failedCount = tasks.filter(t => t.status === 'failed').length
  const blockedCount = tasks.filter(t => t.status === 'blocked').length
  // pending + in_progress 合并为"未完成":中断后报"执行中"与事实不符(循环已终止),
  // 且 in_progress/pending 无 redo 入口(redo 只接受 failed/blocked),不能提示"可 redo"
  const unfinishedCount = tasks.filter(t => t.status === 'pending' || t.status === 'in_progress').length
  if (!allDone) {
    const parts = []
    if (failedCount > 0) parts.push(`${failedCount} 个任务失败`)
    if (blockedCount > 0) parts.push(`${blockedCount} 个任务被阻塞`)
    if (unfinishedCount > 0) parts.push(`${unfinishedCount} 个任务未完成`)
    if (parts.length > 0) {
      const concludeMsg = `执行未完全完成：${parts.join('，')}。失败/阻塞任务可点击 redo 重试，未完成任务将在下次执行时继续`
      await prisma.message.create({ data: { role: 'orchestrator', rawContent: concludeMsg, sessionId } })
      sendEvent({ agentId: 'orchestrator', type: 'text', content: concludeMsg })
    }
  }

  const summary = Array.from(allResults.entries())
    .map(([, result]) => `任务完成：${result.slice(0, 100)}...`)
    .join('\n')
  if (summary) {
    await prisma.message.create({ data: { role: 'orchestrator', rawContent: summary, sessionId } })
    sendEvent({ agentId: 'orchestrator', type: 'done', content: summary })
  } else if (allDone) {
    sendEvent({ agentId: 'orchestrator', type: 'done', content: '所有任务已完成' })
  } else {
    // ISSUE-011 F2: 部分失败且无成功结果时,不谎报"所有任务已完成"
    const parts = []
    if (failedCount > 0) parts.push(`${failedCount} 个失败`)
    if (blockedCount > 0) parts.push(`${blockedCount} 个被阻塞`)
    if (unfinishedCount > 0) parts.push(`${unfinishedCount} 个未完成`)
    sendEvent({ agentId: 'orchestrator', type: 'done', content: `执行结束：${parts.join('，') || '任务未全部完成'}` })
  }
}

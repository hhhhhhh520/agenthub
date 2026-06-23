import { prisma } from '@/lib/db'
import { executeTaskBatch, callLLMForAnalysis, executeSingleAgent, getOrchestratorAgent, type PriorTaskMeta } from '@/lib/orchestrator'
import { buildMonitoringPrompt } from '@/lib/orchestrator/prompts'
import { enforceFileOverlap } from '@/lib/orchestrator/scheduler'
import { getChangedFiles, getGitSnapshot } from './shadow-git'
import { pickSensitive } from './sensitive-paths'
import { validateAgainstSchema } from './schema-validator'
import { TimeoutError } from '@/lib/orchestrator/timeout'
import type { SendEvent } from './review'

interface TraceEntry {
  ts: string
  event: 'start' | 'error' | 'retry' | 'success' | 'blocked' | 'correction'
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

export async function handleExecution(
  message: string,
  sessionId: string,
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string; tools: string }>,
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
  const MAX_ITERATIONS = tasks.length * 3
  let iteration = 0

  const deadline = globalDeadline ?? Date.now() + 50 * 60 * 1000

  while (hasProgress && iteration < MAX_ITERATIONS) {
    if (Date.now() > deadline) {
      console.error('[TIMEOUT] handleExecution 全局耗时超限')
      sendEvent({ agentId: 'orchestrator', type: 'error', content: '执行阶段超时，部分任务未完成' })
      break
    }
    iteration++
    hasProgress = false

    const readyTasks = tasks.filter(t => {
      if (t.status !== 'pending') return false
      const deps: string[] = JSON.parse(t.dependencies || '[]')
      return deps.every(depId => {
        const dep = tasks.find(t2 => t2.id === depId)
        return dep?.status === 'completed'
      })
    })

    if (readyTasks.length === 0) break

    // Create shadow-git snapshot at batch level for boundary detection
    const gitBefore = getGitSnapshot(projectRoot, sessionId)

    for (const task of readyTasks) {
      const startTrace = appendTrace(task.trace || '[]', {
        ts: new Date().toISOString(), event: 'start', agent: agents.find(a => a.id === task.assignedAgentId)?.name,
      })
      await prisma.task.update({ where: { id: task.id }, data: { status: 'in_progress', trace: startTrace } })
      task.status = 'in_progress'
      task.trace = startTrace
      sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId: task.id, status: 'in_progress' }) })
    }

    // Heartbeat: update updatedAt every 60s to prevent stuck task reset
    const heartbeats = new Map<string, NodeJS.Timeout>()
    for (const task of readyTasks) {
      const heartbeat = setInterval(async () => {
        try { await prisma.task.update({ where: { id: task.id }, data: { updatedAt: new Date() } }) }
        catch {}
      }, 60_000)
      heartbeats.set(task.id, heartbeat)
    }

    let results: Map<string, { result: string; sessionId?: string }>
    let batchFailedIds: string[] = []
    try {
      const batchOutcome = await executeTaskBatch(
        readyTasks.map(t => {
          // P1: 纠偏重试时注入越界信息
          let desc = t.description
          if (t.correctionCount > 0) {
            const trace = JSON.parse(t.trace || '[]')
            const last = trace.filter((tr: any) => tr.event === 'correction').pop()
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
    } catch (err) {
      for (const task of readyTasks) {
        const failTrace = appendTrace(task.trace || '[]', {
          ts: new Date().toISOString(), event: 'error', message: err instanceof Error ? err.message : 'Task batch execution failed',
        })
        await prisma.task.update({ where: { id: task.id }, data: { status: 'failed', trace: failTrace } })
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

    for (const taskId of batchFailedIds) {
      const task = tasks.find(t => t.id === taskId)
      if (task && task.status !== 'failed') {
        const failTrace = appendTrace(task.trace || '[]', {
          ts: new Date().toISOString(), event: 'error', message: 'Task failed in batch execution',
        })
        await prisma.task.update({ where: { id: taskId }, data: { status: 'failed', trace: failTrace } })
        task.status = 'failed'
        sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId, status: 'failed' }) })
      }
    }

    for (const [taskId, { result, sessionId: cliSessionId }] of results) {
      allResults.set(taskId, result)
      const taskForTrace = tasks.find(t => t.id === taskId)

      // contract v1 §1.2 b (动作 6): declaredFiles 分级校验
      // 先算 declaredFiles / changedFiles / undeclared / sensitiveViolations,
      // 根据是否命中敏感路径决定 task 最终 status
      const declaredFiles: string[] = JSON.parse(taskForTrace?.declaredFiles || '[]')
      const changedFiles = getChangedFiles(projectRoot, sessionId, gitBefore)
      const undeclared = declaredFiles.length === 0
        ? []  // declaredFiles 为空 = 跳过文件校验(纯讨论/分析任务合法)
        : changedFiles.filter(f => !declaredFiles.includes(f))
      const sensitiveViolations = pickSensitive(undeclared)
      const isSensitiveFail = sensitiveViolations.length > 0

      if (isSensitiveFail) {
        // 硬失败: 敏感路径越界,任务 failed,下游 blocked
        const msg = `[敏感路径越界] 任务 ${taskId} 未声明修改了敏感文件: ${sensitiveViolations.join(', ')}`
        const failTrace = appendTrace(taskForTrace?.trace || '[]', {
          ts: new Date().toISOString(), event: 'error', message: msg,
        })
        await prisma.task.update({
          where: { id: taskId },
          // contract v1 §1.3 P0 (动作 7): 敏感失败清 task.cliSessionId
          // 避免该 agent 进程内存里"我交付成功"的错误信念污染后续任务
          data: { status: 'failed', cliSessionId: null, trace: failTrace },
        })
        // contract v1 §1.3 P0 (动作 7): 同步清 SessionMember.cliSessionId
        // 该 agent 下次接新任务时强制起新 CLI session,不带本次失败的角色记忆
        if (taskForTrace?.assignedAgentId) {
          await prisma.sessionMember.updateMany({
            where: { sessionId, agentId: taskForTrace.assignedAgentId },
            data: { cliSessionId: null },
          })
          memberSessionMap.set(taskForTrace.assignedAgentId, null)
        }
        if (taskForTrace) taskForTrace.status = 'failed'
        await prisma.message.create({ data: { role: 'orchestrator', rawContent: msg, sessionId } })
        sendEvent({ agentId: 'orchestrator', type: 'text', content: msg })
        sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId, status: 'failed' }) })
        continue  // 跳过本任务后续的 success 处理 / monitoring
      }

      const successTrace = appendTrace(taskForTrace?.trace || '[]', {
        ts: new Date().toISOString(), event: 'success',
      })
      // contract v1 §1.1: 持久化 result 到 DB,作为跨批权威载体
      await prisma.task.update({
        where: { id: taskId },
        data: { status: 'completed', cliSessionId: cliSessionId || null, correctionCount: 0, trace: successTrace, result },
      })
      if (taskForTrace) taskForTrace.result = result
      // 同步 sessionId 到 SessionMember,供后续任务 fallback
      if (cliSessionId && taskForTrace?.assignedAgentId) {
        await prisma.sessionMember.updateMany({
          where: { sessionId, agentId: taskForTrace.assignedAgentId },
          data: { cliSessionId },
        })
        memberSessionMap.set(taskForTrace.assignedAgentId, cliSessionId)
      }
      const task = tasks.find(t => t.id === taskId)
      if (task) task.status = 'completed'
      sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId, status: 'completed' }) })
      hasProgress = true

      // contract v1 §1.2 b: 普通越界软警告(敏感越界已在上方硬失败 + continue 处理)
      if (undeclared.length > 0) {
        const msg = `[越界修改] 任务 ${taskId} 未声明修改了 ${undeclared.join(', ')}`
        await prisma.message.create({ data: { role: 'orchestrator', rawContent: msg, sessionId } })
        sendEvent({ agentId: 'orchestrator', type: 'text', content: msg })
      } else if (changedFiles.length > 0) {
        sendEvent({ agentId: 'orchestrator', type: 'text', content: `任务 ${taskId} 完成,修改了 ${changedFiles.join(', ')}` })
      } else {
        sendEvent({ agentId: 'orchestrator', type: 'text', content: `任务 ${taskId} 完成` })
      }

      // contract v1 §1.2 a (动作 5,降级版): outputSchema 软校验
      // 不影响任务状态,只在缺字段/缺 JSON 块时发警告
      const schemaCheck = validateAgainstSchema(result, taskForTrace?.outputSchema)
      if (!schemaCheck.valid) {
        await prisma.message.create({ data: { role: 'orchestrator', rawContent: schemaCheck.message, sessionId } })
        sendEvent({ agentId: 'orchestrator', type: 'text', content: schemaCheck.message })
      }

      try {
        const monitoringPrompt = buildMonitoringPrompt(task?.description || '', result, declaredFiles, { declared: declaredFiles, undeclared })
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
            const correctionMsg = `Orchestrator 纠偏：任务 "${task?.description}" ${review.correctionNote}`
            await prisma.message.create({ data: { role: 'orchestrator', rawContent: correctionMsg, sessionId } })
            sendEvent({ agentId: 'orchestrator', type: 'text', content: correctionMsg })

            const retryCount = task?.correctionCount ?? 0
            if (retryCount < 2) {
              const correctionTrace = appendTrace(task?.trace || '[]', {
                ts: new Date().toISOString(), event: 'correction', message: review.correctionNote, attempt: retryCount + 1,
              })
              // contract v1 §1.3 P0 (动作 7): 纠偏退回 pending 时清 cliSessionId
              // task.result 即将被推翻重写,agent 历史里"我做对了"的认知是脏数据,起新 session 重来
              await prisma.task.update({ where: { id: taskId }, data: { status: 'pending', correctionCount: retryCount + 1, trace: correctionTrace, cliSessionId: null } })
              if (taskForTrace?.assignedAgentId) {
                await prisma.sessionMember.updateMany({
                  where: { sessionId, agentId: taskForTrace.assignedAgentId },
                  data: { cliSessionId: null },
                })
                memberSessionMap.set(taskForTrace.assignedAgentId, null)
              }
              if (task) { task.status = 'pending'; task.correctionCount = retryCount + 1; task.trace = correctionTrace; task.cliSessionId = null }
              sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId, status: 'pending', retryCount: retryCount + 1 }) })
              hasProgress = true
            } else {
              sendEvent({ agentId: 'orchestrator', type: 'text', content: `任务 "${task?.description}" 纠偏重试已达上限(2次)，保持完成状态` })
            }
          }
        }
      } catch (err) {
        if (err instanceof TimeoutError) console.error('[TIMEOUT] monitoring', taskId)
        /* monitoring failed, continue */
      }
    }

    for (const task of tasks) {
      if (task.status !== 'pending') continue
      const deps: string[] = JSON.parse(task.dependencies || '[]')
      const hasFailedDep = deps.some(depId => {
        const dep = tasks.find(t2 => t2.id === depId)
        return dep?.status === 'failed'
      })
      if (hasFailedDep) {
        const blockedTrace = appendTrace(task.trace || '[]', {
          ts: new Date().toISOString(), event: 'blocked', message: '依赖任务失败',
        })
        await prisma.task.update({ where: { id: task.id }, data: { status: 'blocked', trace: blockedTrace } })
        task.status = 'blocked'
        sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId: task.id, status: 'blocked' }) })
      }
    }
  }

  if (iteration >= MAX_ITERATIONS) {
    sendEvent({ agentId: 'orchestrator', type: 'error', content: '执行循环超过安全上限，已终止' })
  }

  const allDone = tasks.every(t => t.status === 'completed' || t.status === 'blocked')
  if (allDone) {
    await prisma.session.update({ where: { id: sessionId }, data: { phase: 'done', phaseStep: '' } })
  }

  const summary = Array.from(allResults.entries())
    .map(([, result]) => `任务完成：${result.slice(0, 100)}...`)
    .join('\n')
  if (summary) {
    await prisma.message.create({ data: { role: 'orchestrator', rawContent: summary, sessionId } })
    sendEvent({ agentId: 'orchestrator', type: 'done', content: summary })
  } else {
    sendEvent({ agentId: 'orchestrator', type: 'done', content: '所有任务已完成' })
  }
}

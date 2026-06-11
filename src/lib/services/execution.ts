import { prisma } from '@/lib/db'
import { executeTaskBatch, callLLMForAnalysis, executeSingleAgent, getOrchestratorAgent } from '@/lib/orchestrator'
import { buildMonitoringPrompt } from '@/lib/orchestrator/prompts'
import { enforceFileOverlap } from '@/lib/orchestrator/scheduler'
import { getChangedFiles, getGitSnapshot } from './git-utils'
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

  const allResults = new Map<string, string>()
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

    // Create git snapshot at batch level for boundary detection
    const gitBefore = getGitSnapshot(projectRoot)

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
        projectRoot
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
      const successTrace = appendTrace(taskForTrace?.trace || '[]', {
        ts: new Date().toISOString(), event: 'success',
      })
      await prisma.task.update({
        where: { id: taskId },
        data: { status: 'completed', cliSessionId: cliSessionId || null, correctionCount: 0, trace: successTrace },
      })
      // 同步 sessionId 到 SessionMember，供后续任务 fallback
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

      const declaredFiles: string[] = JSON.parse(task?.declaredFiles || '[]')
      const changedFiles = getChangedFiles(projectRoot, gitBefore)
      const undeclared = changedFiles.filter(f => !declaredFiles.includes(f))
      if (undeclared.length > 0) {
        const msg = `[越界修改] 任务 ${taskId} 未声明修改了 ${undeclared.join(', ')}`
        await prisma.message.create({ data: { role: 'orchestrator', rawContent: msg, sessionId } })
        sendEvent({ agentId: 'orchestrator', type: 'text', content: msg })
      } else if (changedFiles.length > 0) {
        sendEvent({ agentId: 'orchestrator', type: 'text', content: `任务 ${taskId} 完成，修改了 ${changedFiles.join(', ')}` })
      } else {
        sendEvent({ agentId: 'orchestrator', type: 'text', content: `任务 ${taskId} 完成` })
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
              await prisma.task.update({ where: { id: taskId }, data: { status: 'pending', correctionCount: retryCount + 1, trace: correctionTrace } })
              if (task) { task.status = 'pending'; task.correctionCount = retryCount + 1; task.trace = correctionTrace }
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

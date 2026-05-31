import { prisma } from '@/lib/db'
import { executeTaskBatch, callLLMForAnalysis } from '@/lib/orchestrator'
import { buildMonitoringPrompt } from '@/lib/orchestrator/prompts'
import { enforceFileOverlap } from '@/lib/orchestrator/scheduler'
import { getChangedFiles, getGitSnapshot } from './git-utils'
import { buildContextFromHistory } from './context-builder'
import type { SendEvent } from './review'

export async function handleExecution(
  message: string,
  sessionId: string,
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string; tools: string }>,
  sendEvent: SendEvent
) {
  const tasks = await prisma.task.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  })

  if (tasks.length === 0) {
    sendEvent({ agentId: 'orchestrator', type: 'error', content: '没有待执行的任务' })
    return
  }

  const allMessages = await prisma.message.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } })
  const context = buildContextFromHistory(allMessages)

  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  const projectRoot = session?.projectDir && session.projectDir.trim()
    ? session.projectDir.trim()
    : process.cwd()

  const gitBefore = getGitSnapshot(projectRoot)

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

  const allResults = new Map<string, string>()
  let hasProgress = true
  const MAX_ITERATIONS = tasks.length * 3
  let iteration = 0

  while (hasProgress && iteration < MAX_ITERATIONS) {
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

    for (const task of readyTasks) {
      await prisma.task.update({ where: { id: task.id }, data: { status: 'in_progress' } })
      task.status = 'in_progress'
      sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId: task.id, status: 'in_progress' }) })
    }

    let results: Map<string, { result: string; sessionId?: string }>
    let batchFailedIds: string[] = []
    try {
      const batchOutcome = await executeTaskBatch(
        readyTasks.map(t => ({
          id: t.id,
          description: t.description,
          assignedAgent: agents.find(a => a.id === t.assignedAgentId)?.name || '',
          dependencies: JSON.parse(t.dependencies || '[]'),
          declaredFiles: JSON.parse(t.declaredFiles || '[]'),
          batch: 0,
        })),
        agents.map(a => {
          const task = tasks.find(t => t.assignedAgentId === a.id)
          return {
            name: a.name,
            systemPrompt: a.systemPrompt,
            platform: a.platform,
            model: a.model,
            baseUrl: a.baseUrl,
            apiKey: a.apiKey,
            sessionId: task?.cliSessionId || undefined,
            permissionMode: session?.permissionMode || 'default',
          }
        }),
        context,
        (taskId, chunk) => sendEvent({ agentId: taskId, type: chunk.type, content: chunk.content, data: chunk.data }),
        sessionId,
        projectRoot
      )
      results = batchOutcome.results
      batchFailedIds = batchOutcome.failedTaskIds
    } catch {
      for (const task of readyTasks) {
        await prisma.task.update({ where: { id: task.id }, data: { status: 'failed' } })
        task.status = 'failed'
        sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId: task.id, status: 'failed' }) })
      }
      results = new Map()
    }

    for (const taskId of batchFailedIds) {
      const task = tasks.find(t => t.id === taskId)
      if (task && task.status !== 'failed') {
        await prisma.task.update({ where: { id: taskId }, data: { status: 'failed' } })
        task.status = 'failed'
        sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId, status: 'failed' }) })
      }
    }

    for (const [taskId, { result, sessionId: cliSessionId }] of results) {
      allResults.set(taskId, result)
      await prisma.task.update({
        where: { id: taskId },
        data: { status: 'completed', cliSessionId: cliSessionId || null, correctionCount: 0 },
      })
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
        const reviewResult = await callLLMForAnalysis(monitoringPrompt)
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
              await prisma.task.update({ where: { id: taskId }, data: { status: 'pending', correctionCount: retryCount + 1 } })
              if (task) { task.status = 'pending'; task.correctionCount = retryCount + 1 }
              sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId, status: 'pending', retryCount: retryCount + 1 }) })
              hasProgress = true
            } else {
              sendEvent({ agentId: 'orchestrator', type: 'text', content: `任务 "${task?.description}" 纠偏重试已达上限(2次)，保持完成状态` })
            }
          }
        }
      } catch { /* monitoring failed, continue */ }
    }

    for (const task of tasks) {
      if (task.status !== 'pending') continue
      const deps: string[] = JSON.parse(task.dependencies || '[]')
      const hasFailedDep = deps.some(depId => {
        const dep = tasks.find(t2 => t2.id === depId)
        return dep?.status === 'failed'
      })
      if (hasFailedDep) {
        await prisma.task.update({ where: { id: task.id }, data: { status: 'blocked' } })
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

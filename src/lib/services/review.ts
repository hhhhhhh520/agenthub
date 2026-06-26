import { prisma } from '@/lib/db'
import { executeSingleAgent, runDiscussion, callLLMForAnalysis, getOrchestratorAgent } from '@/lib/orchestrator'
import { buildMonitoringPrompt, ORCHESTRATOR_DECISION_PROMPT } from '@/lib/orchestrator/prompts'
import type { TaskAttachment } from '@/lib/adapter/types'

export type SendEvent = (data: { agentId: string; type: string; content: string; data?: { requestId?: string; toolName?: string; toolInput?: Record<string, unknown>; quality?: string } }) => void

const REVIEW_MAX_ELAPSED_MS = 10 * 60 * 1000

export async function reviewResult(
  result: string,
  taskDescription: string,
  sessionId: string,
  sendEvent: SendEvent,
  retryContext?: {
    agent: { name: string; systemPrompt: string; platform: string; model?: string; baseUrl?: string; apiKey?: string; id?: string; tools?: string }
    maxRetries?: number
    currentRetry?: number
    chatSessionId?: string
    projectDir?: string
  },
  orchSessionId?: string,
  startTime: number = Date.now()
): Promise<{ quality: string }> {
  // 总耗时超限检查
  if (Date.now() - startTime > REVIEW_MAX_ELAPSED_MS) {
    console.error('[TIMEOUT] reviewResult 总耗时超限')
    return { quality: 'poor' }
  }
  try {
    const monitoringPrompt = buildMonitoringPrompt(taskDescription, result, [], { declared: [], undeclared: [] }, 'single')
    const orch = await getOrchestratorAgent()
    const { result: reviewOutput } = await executeSingleAgent(
      {
        name: 'Orchestrator',
        systemPrompt: '你是代码审查专家，负责检查 Agent 输出质量。返回 JSON 格式的审查结果。',
        platform: orch.platform,
        model: orch.model || undefined,
        baseUrl: orch.baseUrl || undefined,
        apiKey: orch.apiKey || undefined,
        sessionId: orchSessionId,
        workDir: retryContext?.projectDir,
        permissionMode: 'auto',
      },
      monitoringPrompt,
      '',
      () => {},
      retryContext?.chatSessionId,
      retryContext?.projectDir
    )
    const cleaned = reviewOutput.replace(/```json?\s*([\s\S]*?)```/, '$1').trim()
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const review = JSON.parse(jsonMatch[0])
      if (review.needsCorrection && review.correctionNote) {
        const correctionMsg = `Orchestrator 纠偏：${review.correctionNote}`
        await prisma.message.create({ data: { role: 'orchestrator', rawContent: correctionMsg, sessionId } })
        sendEvent({ agentId: 'orchestrator', type: 'text', content: correctionMsg, data: { quality: 'poor' } })

        // 如果有重试上下文且未超过最大重试次数，自动重新执行 Agent
        const maxRetries = retryContext?.maxRetries ?? 3
        const currentRetry = retryContext?.currentRetry ?? 0

        if (retryContext?.agent && currentRetry < maxRetries && Date.now() - startTime < REVIEW_MAX_ELAPSED_MS) {
          sendEvent({ agentId: 'orchestrator', type: 'text', content: `正在要求 Agent 改进（第 ${currentRetry + 1}/${maxRetries} 次重试）...` })

          const retryPrompt = `之前的结果有问题：${review.correctionNote}\n\n原始任务：${taskDescription}\n\n请重新完成任务，确保修复上述问题。`

          try {
            const { result: retryResult } = await executeSingleAgent(
              {
                ...retryContext.agent,
                workDir: retryContext.projectDir,
              },
              retryPrompt,
              '',
              (agentId, chunk) => {
                if (chunk.type === 'status') return
                sendEvent({ agentId, type: chunk.type, content: chunk.content, data: chunk.data })
              },
              retryContext.chatSessionId,
              retryContext.projectDir,
            )

            // 保存重试结果
            await prisma.message.create({
              data: { role: 'agent', rawContent: retryResult, sessionId, agentId: retryContext.agent.name },
            })

            // 递归检查重试结果
            return reviewResult(retryResult, taskDescription, sessionId, sendEvent, {
              ...retryContext,
              currentRetry: currentRetry + 1,
            }, orchSessionId, startTime)
          } catch {
            // 重试失败，明确标记为差
            return { quality: 'poor' }
          }
        }

        return { quality: review.quality || 'poor' }
      }
      return { quality: review.quality || 'good' }
    }
  } catch (err) {
    console.warn(`[reviewResult] Monitoring failed, skipping: ${err}`)
  }
  return { quality: 'good' }
}

export async function delegateToAgent(
  agentName: string,
  taskMessage: string,
  sessionId: string,
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string; tools: string }>,
  sendEvent: SendEvent,
  attachments?: TaskAttachment[],
  orchSessionId?: string
) {
  let agent = agents.find(a => a.name === agentName)
  if (!agent) {
    agent = agents.find(a => a.name.includes(agentName) || agentName.includes(a.name))
  }
  if (!agent) {
    sendEvent({ agentId: 'orchestrator', type: 'error', content: `未找到名为「${agentName}」的 Agent。可用：${agents.map(a => a.name).join('、')}` })
    return
  }

  sendEvent({ agentId: agent.name, type: 'status', content: '执行中...' })

  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  const workDir = session?.projectDir && session.projectDir.trim()
    ? session.projectDir.trim()
    : process.cwd()

  // 从 SessionMember 读取 cliSessionId 用于会话恢复
  const member = await prisma.sessionMember.findUnique({
    where: { sessionId_agentId: { sessionId, agentId: agent.id } },
  })

  const { result } = await executeSingleAgent(
    { id: agent.id, name: agent.name, systemPrompt: agent.systemPrompt, platform: agent.platform, model: agent.model, baseUrl: agent.baseUrl, apiKey: agent.apiKey, workDir, permissionMode: session?.permissionMode || 'default', sessionId: member?.cliSessionId || undefined },
    taskMessage,
    '',  // 不传 context，CLI 通过 session 恢复管理历史
    (agentId, chunk) => {
      // status chunk 不发送给前端（如 "completed"）
      if (chunk.type === 'status') return
      sendEvent({ agentId, type: chunk.type, content: chunk.content, data: chunk.data })
    },
    sessionId,
    workDir,
    attachments
  )

  await prisma.message.create({
    data: { role: 'agent', rawContent: result, sessionId, agentId: agent.name },
  })

  const { quality } = await reviewResult(result, taskMessage, sessionId, sendEvent, {
    agent: { name: agent.name, systemPrompt: agent.systemPrompt, platform: agent.platform, model: agent.model, baseUrl: agent.baseUrl, apiKey: agent.apiKey, id: agent.id, tools: agent.tools },
    maxRetries: 3,
    currentRetry: 0,
    chatSessionId: sessionId,
    projectDir: workDir,
  }, orchSessionId)
  sendEvent({ agentId: agent.name, type: 'done', content: result, data: { quality } })
}

export async function runMultiAgentDiscussion(
  agentNames: string[],
  topic: string,
  sessionId: string,
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string; tools: string }>,
  sendEvent: SendEvent
) {
  const discussionAgents = agentNames
    .map(name => {
      let found = agents.find(a => a.name === name)
      if (!found) {
        found = agents.find(a => a.name.includes(name) || name.includes(a.name))
      }
      return found
    })
    .filter(Boolean)
    .map(a => ({ name: a!.name, systemPrompt: a!.systemPrompt, platform: a!.platform, model: a!.model, baseUrl: a!.baseUrl, apiKey: a!.apiKey }))

  if (discussionAgents.length === 0) {
    sendEvent({ agentId: 'orchestrator', type: 'error', content: `未找到参与讨论的 Agent。请求：${agentNames.join('、')}，可用：${agents.map(a => a.name).join('、')}` })
    return
  }

  sendEvent({ agentId: 'orchestrator', type: 'status', content: `${agentNames.join('、')} 讨论中...` })

  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  const workDir = session?.projectDir && session.projectDir.trim()
    ? session.projectDir.trim()
    : process.cwd()

  const opinions = await runDiscussion(
    topic,
    discussionAgents,
    3,
    (agentName, chunk) => sendEvent({ agentId: agentName, type: chunk.type, content: chunk.content, data: chunk.data }),
    sessionId,
    workDir
  )

  const summary = opinions.join('\n\n')
  // 判断讨论是否成功：至少有一个 Agent 给出了有效内容（非超时/出错）
  const hasValidContent = opinions.some(
    op => !op.includes('讨论超时') && !op.includes('讨论出错') && !op.includes('未返回有效内容')
  )
  const statusTag = hasValidContent ? '[STATUS:success]' : '[STATUS:failed]'
  await prisma.message.create({
    data: {
      role: 'orchestrator',
      rawContent: `[DISCUSSION_SUMMARY]${statusTag}${summary}`,
      sessionId,
    },
  })
  const { quality: discQuality } = await reviewResult(summary, topic, sessionId, sendEvent, undefined, undefined)
  sendEvent({ agentId: 'orchestrator', type: 'done', content: summary, data: { quality: discQuality } })
}

import { prisma } from '@/lib/db'
import { executeSingleAgent, runDiscussion, callLLMForAnalysis } from '@/lib/orchestrator'
import { buildMonitoringPrompt } from '@/lib/orchestrator/prompts'
import { buildContextFromHistory } from './context-builder'

export type SendEvent = (data: { agentId: string; type: string; content: string; data?: { requestId?: string; toolName?: string; toolInput?: Record<string, unknown>; quality?: string } }) => void

export async function reviewResult(
  result: string,
  taskDescription: string,
  sessionId: string,
  sendEvent: SendEvent
): Promise<{ quality: string }> {
  try {
    const monitoringPrompt = buildMonitoringPrompt(taskDescription, result, [], { declared: [], undeclared: [] }, 'single')
    const reviewOutput = await callLLMForAnalysis(monitoringPrompt)
    const cleaned = reviewOutput.replace(/```json?\s*([\s\S]*?)```/, '$1').trim()
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const review = JSON.parse(jsonMatch[0])
      if (review.needsCorrection && review.correctionNote) {
        const correctionMsg = `Orchestrator 纠偏：${review.correctionNote}`
        await prisma.message.create({ data: { role: 'orchestrator', rawContent: correctionMsg, sessionId } })
        sendEvent({ agentId: 'orchestrator', type: 'text', content: correctionMsg, data: { quality: 'poor' } })
        return { quality: review.quality || 'poor' }
      }
      return { quality: review.quality || 'good' }
    }
  } catch { /* monitoring failed, skip */ }
  return { quality: 'good' }
}

export async function delegateToAgent(
  agentName: string,
  taskMessage: string,
  sessionId: string,
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string; tools: string }>,
  sendEvent: SendEvent
) {
  const agent = agents.find(a => a.name === agentName)
  if (!agent) {
    sendEvent({ agentId: 'orchestrator', type: 'error', content: `未找到名为 ${agentName} 的 Agent` })
    return
  }

  sendEvent({ agentId: agent.name, type: 'status', content: '执行中...' })

  const history = await prisma.message.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } })
  const context = buildContextFromHistory(history)

  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  const workDir = session?.projectDir && session.projectDir.trim()
    ? session.projectDir.trim()
    : process.cwd()

  const { result } = await executeSingleAgent(
    { name: agent.name, systemPrompt: agent.systemPrompt, platform: agent.platform, model: agent.model, baseUrl: agent.baseUrl, apiKey: agent.apiKey, workDir, permissionMode: session?.permissionMode || 'default' },
    taskMessage,
    context,
    (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content, data: chunk.data }),
    sessionId,
    workDir
  )

  await prisma.message.create({
    data: { role: 'agent', rawContent: result, sessionId, agentId: agent.name },
  })

  const { quality } = await reviewResult(result, taskMessage, sessionId, sendEvent)
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
    .map(name => agents.find(a => a.name === name))
    .filter(Boolean)
    .map(a => ({ name: a!.name, systemPrompt: a!.systemPrompt, platform: a!.platform, model: a!.model, baseUrl: a!.baseUrl, apiKey: a!.apiKey }))

  if (discussionAgents.length === 0) {
    sendEvent({ agentId: 'orchestrator', type: 'error', content: '未找到参与讨论的 Agent' })
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
  await prisma.message.create({
    data: { role: 'orchestrator', rawContent: summary, sessionId },
  })
  const { quality: discQuality } = await reviewResult(summary, topic, sessionId, sendEvent)
  sendEvent({ agentId: 'orchestrator', type: 'done', content: summary, data: { quality: discQuality } })
}

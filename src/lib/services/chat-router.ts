import { prisma } from '@/lib/db'
import { getOrchestratorDecision, executeSingleAgent, getOrchestratorAgent } from '@/lib/orchestrator'
import { buildContextFromHistory } from './context-builder'
import { reviewResult, delegateToAgent, runMultiAgentDiscussion } from './review'
import { handlePMConfirm, handleArchitectPlan, handleAgentQA, transitionToExecution } from './alignment'
import type { SendEvent } from './review'
import type { TaskAttachment } from '@/lib/adapter/types'

export async function handleOrchestratorDecision(
  message: string,
  sessionId: string,
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string; tools: string }>,
  sendEvent: SendEvent,
  sessionPhase: string,
  attachments?: TaskAttachment[],
  workDir?: string
) {
  sendEvent({ agentId: 'orchestrator', type: 'status', content: '思考中...' })

  const history = await prisma.message.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' }, include: { attachments: true } })
  const context = buildContextFromHistory(history)

  let decision: { action: string; target?: string | null; targets?: string[] | null; message: string; reason: string }
  let orchSessionId: string | undefined
  try {
    const result = await getOrchestratorDecision(
      message,
      agents.map(a => ({ name: a.name, expertise: a.expertise, platform: a.platform })),
      context,
      workDir
    )
    decision = result.decision
    orchSessionId = result.sessionId
  } catch {
    await handleOrchestratorChat(message, sessionId, sendEvent, agents)
    return
  }

  sendEvent({ agentId: 'orchestrator', type: 'text', content: `[决策] ${decision.reason}` })

  decision = validateDecision(decision, sessionPhase, history)

  if (decision.action === 'execute') {
    const taskCount = await prisma.task.count({ where: { sessionId } })
    if (taskCount === 0) {
      decision = { ...decision, action: 'align_decompose', reason: '尚无任务，需架构师先拆解' }
    }
  }

  // If delegate is chosen but there are pending tasks, append a note but don't override the action
  if (decision.action === 'delegate') {
    const pendingTasks = await prisma.task.count({ where: { sessionId, status: 'pending' } })
    if (pendingTasks > 0) {
      decision = { ...decision, reason: `${decision.reason}（另有${pendingTasks}个待执行任务）` }
    }
  }

  switch (decision.action) {
    case 'self':
      await handleOrchestratorChat(message, sessionId, sendEvent, agents, orchSessionId)
      break
    case 'delegate':
      if (decision.target) {
        await delegateToAgent(decision.target, decision.message || message, sessionId, agents, sendEvent, attachments, orchSessionId)
      }
      break
    case 'discuss':
      if (decision.targets && decision.targets.length > 0) {
        await runMultiAgentDiscussion(decision.targets, decision.message || message, sessionId, agents, sendEvent)
      }
      break
    case 'align_confirm':
      await handlePMConfirm(message, sessionId, agents, sendEvent)
      break
    case 'align_decompose':
      await handleArchitectPlan(message, sessionId, agents, sendEvent)
      break
    case 'align_qa':
      await handleAgentQA(message, sessionId, agents, sendEvent)
      break
    case 'execute':
      await transitionToExecution(sessionId, agents, sendEvent, message, orchSessionId)
      break
    case 'done':
      await prisma.session.update({ where: { id: sessionId }, data: { phase: 'done', phaseStep: '' } })
      sendEvent({ agentId: 'orchestrator', type: 'text', content: decision.message || '任务已完成' })
      sendEvent({ agentId: 'orchestrator', type: 'done', content: decision.message || '任务已完成' })
      break
  }
}

export function validateDecision(
  decision: { action: string; target?: string | null; targets?: string[] | null; message: string; reason: string },
  currentPhase: string,
  history: Array<{ role: string; agentId?: string | null; rawContent: string }>
): { action: string; target?: string | null; targets?: string[] | null; message: string; reason: string } {
  if (currentPhase === 'alignment' && decision.action === 'done') {
    return { ...decision, action: 'align_confirm', reason: '对齐尚未完成，继续确认需求' }
  }

  if (currentPhase === 'execution' && decision.action.startsWith('align_')) {
    return { ...decision, action: 'execute', reason: '已在执行阶段' }
  }

  if (decision.action === 'align_qa') {
    const agentQuestions = history.filter(
      m => m.role === 'agent' && m.agentId && m.agentId !== '产品经理' && m.agentId !== '架构师'
    )
    if (agentQuestions.length > 0) {
      const lastAgentQuestionIdx = history.reduce((last, m, i) =>
        (m.role === 'agent' && m.agentId && m.agentId !== '产品经理' && m.agentId !== '架构师') ? i : last, -1
      )
      const userAnswersAfter = history.slice(lastAgentQuestionIdx + 1).filter(m => m.role === 'user')
      if (userAnswersAfter.length > 0) {
        return { ...decision, action: 'execute', reason: 'Q&A已完成，开始执行' }
      }
    }
  }

  return decision
}

export async function handleOrchestratorChat(
  message: string,
  sessionId: string,
  sendEvent: SendEvent,
  agents?: Array<{ name: string; expertise: string; platform: string }>,
  orchSessionId?: string
) {
  sendEvent({ agentId: 'orchestrator', type: 'status', content: '思考中...' })

  const agentList = (agents || []).map(a => `- ${a.name}（${a.expertise}，平台：${a.platform}）`).join('\n')
  const systemPrompt = `你是 AgentHub 的 Orchestrator，一个多 Agent 协作平台的协调者。

当前会话中的 Agent：
${agentList || '（无）'}

你的职责：
- 和用户闲聊、回答问题、解释功能
- 当用户下达开发任务（包含"开发/实现/做/写/搭建"等关键词）时，启动对齐流程
- 当用户 @某个 Agent 时，告诉用户该 Agent 的能力和状态
- 回复简洁，不要用 emoji，控制在 200 字以内`

  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  const workDir = session?.projectDir && session.projectDir.trim()
    ? session.projectDir.trim()
    : process.cwd()

  const orchConfig = await getOrchestratorAgent()
  const { result } = await executeSingleAgent(
    {
      name: 'Orchestrator', systemPrompt, platform: orchConfig.platform,
      apiKey: orchConfig.apiKey || undefined,
      model: orchConfig.model,
      baseUrl: orchConfig.baseUrl || undefined,
      workDir, permissionMode: session?.permissionMode || 'default',
      sessionId: orchSessionId,
    },
    message,
    '',
    (agentId, chunk) => {
      // status chunk 不发送给前端（如 "completed"）
      if (chunk.type === 'status') return

      if (chunk.type === 'error') {
        const errMsg = chunk.content
        let friendlyMsg = '处理消息时出错，请稍后重试'
        if (errMsg.includes('400') || errMsg.includes('Param')) {
          friendlyMsg = 'AI 服务暂时不可用，请检查 API 配置后重试'
        } else if (errMsg.includes('timeout') || errMsg.includes('超时')) {
          friendlyMsg = '请求超时，请稍后重试'
        } else if (errMsg.includes('ECONNREFUSED') || errMsg.includes('fetch')) {
          friendlyMsg = '无法连接到 AI 服务，请检查网络连接'
        }
        sendEvent({ agentId, type: 'error', content: friendlyMsg })
      } else {
        sendEvent({ agentId, type: chunk.type, content: chunk.content, data: chunk.data })
      }
    },
    sessionId,
    workDir
  )

  await prisma.message.create({
    data: { role: 'orchestrator', rawContent: result, sessionId },
  })
  sendEvent({ agentId: 'orchestrator', type: 'done', content: result })
}

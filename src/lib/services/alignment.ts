import { prisma } from '@/lib/db'
import { executeSingleAgent, callLLMForAnalysis, analyzeScene, generateRoles, decomposeTasks, parseJSON, formatArchitectPlan } from '@/lib/orchestrator'
import { PM_CONFIRMATION_PROMPT, buildAgentQuestionPrompt } from '@/lib/orchestrator/prompts'
import { topologicalSort, type ScheduledTask } from '@/lib/orchestrator/scheduler'
import { handleExecution } from './execution'
import type { SendEvent } from './review'

export async function handlePMConfirm(
  message: string,
  sessionId: string,
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string; tools: string }>,
  sendEvent: SendEvent
) {
  let currentAgents = agents

  if (currentAgents.length === 0) {
    sendEvent({ agentId: 'orchestrator', type: 'status', content: '正在分析任务并组建团队...' })
    try {
      const scene = await analyzeScene(message)
      const agentConfigs = await generateRoles(scene.type, scene.description)

      for (const config of agentConfigs) {
        const existing = await prisma.agent.findUnique({ where: { name: config.name } })
        const name = existing ? `${config.name}_${Date.now().toString(36).slice(-4)}` : config.name
        const agent = await prisma.agent.create({
          data: { name, expertise: config.expertise, systemPrompt: config.systemPrompt, platform: config.platform, capabilities: '[]', accentColor: '#6366f1', isPreset: false },
        })
        await prisma.sessionMember.create({ data: { sessionId, agentId: agent.id } })
      }

      const members = await prisma.sessionMember.findMany({ where: { sessionId }, include: { agent: true } })
      currentAgents = members.map(m => m.agent)
      const names = currentAgents.map(a => a.name).join('、')
      sendEvent({ agentId: 'orchestrator', type: 'text', content: `已组建团队：${names}` })
    } catch {
      sendEvent({ agentId: 'orchestrator', type: 'error', content: '组建团队失败，请重试或手动添加 Agent' })
      return
    }
  }

  await prisma.session.update({ where: { id: sessionId }, data: { phase: 'alignment', phaseStep: 'pm_confirm' } })
  sendEvent({ agentId: 'orchestrator', type: 'phase_transition', content: 'alignment' })

  const pmPrompt = PM_CONFIRMATION_PROMPT.replace('{userMessage}', message)
  const pmAgent = currentAgents.find(a => a.name === '产品经理')

  if (pmAgent) {
    const session = await prisma.session.findUnique({ where: { id: sessionId } })
    const workDir = session?.projectDir && session.projectDir.trim()
      ? session.projectDir.trim()
      : process.cwd()

    // 从 SessionMember 读取 cliSessionId 用于会话恢复
    const member = await prisma.sessionMember.findUnique({
      where: { sessionId_agentId: { sessionId, agentId: pmAgent.id } },
    })

    try {
      const { result } = await executeSingleAgent(
        { name: pmAgent.name, systemPrompt: pmAgent.systemPrompt, platform: pmAgent.platform, model: pmAgent.model, baseUrl: pmAgent.baseUrl, apiKey: pmAgent.apiKey, workDir, permissionMode: session?.permissionMode || 'default', id: pmAgent.id, tools: pmAgent.tools, sessionId: member?.cliSessionId || undefined },
        pmPrompt,
        '',  // 不传 context，CLI 通过 session 恢复管理历史
        (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content, data: chunk.data }),
        sessionId,
        workDir
      )
      await prisma.message.create({ data: { role: 'agent', rawContent: result, sessionId, agentId: '产品经理' } })
      sendEvent({ agentId: '产品经理', type: 'done', content: result })
      sendEvent({ agentId: 'orchestrator', type: 'awaiting_user_input', content: 'pm_confirm' })
    } catch {
      sendEvent({ agentId: 'orchestrator', type: 'error', content: '需求确认失败，请重试' })
    }
  } else {
    sendEvent({ agentId: '产品经理', type: 'status', content: '正在确认需求...' })
    try {
      // Build prompt with system context since callLLMForAnalysis doesn't support systemPrompt
      const systemContext = '你是一位经验丰富的产品经理，擅长需求分析和产品设计。请根据用户描述，整理出清晰的需求文档。'
      const enhancedPrompt = `${systemContext}\n\n---\n\n${pmPrompt}`
      const result = await callLLMForAnalysis(enhancedPrompt)
      await prisma.message.create({ data: { role: 'agent', rawContent: result, sessionId, agentId: '产品经理' } })
      sendEvent({ agentId: '产品经理', type: 'done', content: result })
      sendEvent({ agentId: 'orchestrator', type: 'awaiting_user_input', content: 'pm_confirm' })
    } catch {
      sendEvent({ agentId: 'orchestrator', type: 'error', content: '需求确认失败，请重试' })
    }
  }
}

export async function handleArchitectPlan(
  message: string,
  sessionId: string,
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string; tools: string }>,
  sendEvent: SendEvent
) {
  await prisma.session.update({ where: { id: sessionId }, data: { phase: 'alignment', phaseStep: 'architect_plan' } })
  sendEvent({ agentId: 'orchestrator', type: 'phase_transition', content: 'alignment' })

  const history = await prisma.message.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } })
  const originalRequest = history.find(m => m.role === 'user')?.rawContent || message

  const archAgent = agents.find(a => a.name === '架构师')
  let scheduledTasks: ScheduledTask[]

  if (archAgent) {
    const session = await prisma.session.findUnique({ where: { id: sessionId } })
    const workDir = session?.projectDir && session.projectDir.trim()
      ? session.projectDir.trim()
      : process.cwd()
    const agentList = agents.map(a => `${a.name}（${a.expertise}）`).join('、')
    const archPrompt = `任务描述：${originalRequest}\n可用角色：${agentList}`

    // 从 SessionMember 读取 cliSessionId 用于会话恢复
    const member = await prisma.sessionMember.findUnique({
      where: { sessionId_agentId: { sessionId, agentId: archAgent.id } },
    })

    sendEvent({ agentId: archAgent.name, type: 'status', content: '正在拆解任务...' })
    try {
      const { result } = await executeSingleAgent(
        { name: archAgent.name, systemPrompt: archAgent.systemPrompt, platform: archAgent.platform, model: archAgent.model, baseUrl: archAgent.baseUrl, apiKey: archAgent.apiKey, workDir, permissionMode: session?.permissionMode || 'default', id: archAgent.id, tools: archAgent.tools, sessionId: member?.cliSessionId || undefined },
        archPrompt,
        '',  // 不传 context，CLI 通过 session 恢复管理历史
        (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content, data: chunk.data }),
        sessionId,
        workDir
      )

      try {
        const parsed = parseJSON<{ tasks: Array<{ id: number; description: string; assignedAgent: string; dependencies: number[]; declared_files?: string[] }> }>(result, ['tasks'])
        const idMap = new Map<number, string>()
        parsed.tasks.forEach(t => idMap.set(t.id, crypto.randomUUID()))
        scheduledTasks = topologicalSort(parsed.tasks.map(t => ({
          id: idMap.get(t.id)!,
          description: t.description,
          assignedAgent: t.assignedAgent,
          dependencies: t.dependencies.map(d => idMap.get(d)!).filter(Boolean),
          declaredFiles: t.declared_files || [],
          batch: 0,
        })))
      } catch {
        sendEvent({ agentId: archAgent.name, type: 'status', content: '任务拆解格式异常，正在重新生成...' })
        scheduledTasks = await decomposeTasks(originalRequest, agents.map(a => ({ name: a.name, expertise: a.expertise })))
      }
    } catch {
      scheduledTasks = await decomposeTasks(originalRequest, agents.map(a => ({ name: a.name, expertise: a.expertise })))
    }
  } else {
    sendEvent({ agentId: '架构师', type: 'status', content: '正在拆解任务...' })
    scheduledTasks = await decomposeTasks(originalRequest, agents.map(a => ({ name: a.name, expertise: a.expertise })))
  }

  if (scheduledTasks.length === 0) {
    sendEvent({ agentId: '架构师', type: 'text', content: '未能生成有效任务方案，请重新描述需求或手动指定任务' })
    return
  }

  const agentNameToId = new Map(agents.map(a => [a.name, a.id]))
  for (const task of scheduledTasks) {
    await prisma.task.create({
      data: {
        id: task.id,
        description: task.description,
        status: 'pending',
        assignedAgentId: agentNameToId.get(task.assignedAgent) || null,
        sessionId,
        dependencies: JSON.stringify(task.dependencies),
        declaredFiles: JSON.stringify(task.declaredFiles),
      },
    })
  }

  const planSummary = formatArchitectPlan(scheduledTasks, agents)
  await prisma.message.create({ data: { role: 'agent', rawContent: planSummary, sessionId, agentId: '架构师' } })
  sendEvent({ agentId: '架构师', type: 'done', content: planSummary })
  sendEvent({ agentId: 'orchestrator', type: 'awaiting_user_input', content: 'architect_plan' })
}

export async function handleAgentQA(
  message: string,
  sessionId: string,
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string; tools: string }>,
  sendEvent: SendEvent
) {
  await prisma.session.update({ where: { id: sessionId }, data: { phase: 'alignment', phaseStep: 'agent_qa' } })

  const history = await prisma.message.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } })
  const originalRequest = history.find(m => m.role === 'user')?.rawContent || ''
  const architectPlan = history.find(m => m.agentId === '架构师')?.rawContent || ''

  sendEvent({ agentId: 'orchestrator', type: 'status', content: '多个 Agent 正在整理问题...' })

  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  const workDir = session?.projectDir && session.projectDir.trim()
    ? session.projectDir.trim()
    : process.cwd()

  const results = await Promise.allSettled(
    agents.map(async (agent) => {
      const prompt = buildAgentQuestionPrompt(agent.name, agent.expertise, originalRequest, architectPlan)
      try {
        // 从 SessionMember 读取 cliSessionId 用于会话恢复
        const member = await prisma.sessionMember.findUnique({
          where: { sessionId_agentId: { sessionId, agentId: agent.id } },
        })
        const { result } = await executeSingleAgent(
          { name: agent.name, systemPrompt: agent.systemPrompt, platform: agent.platform, model: agent.model, baseUrl: agent.baseUrl, apiKey: agent.apiKey, workDir, permissionMode: session?.permissionMode || 'default', id: agent.id, tools: agent.tools, sessionId: member?.cliSessionId || undefined },
          prompt,
          '',  // 不传 context，CLI 通过 session 恢复管理历史
          (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content, data: chunk.data }),
          sessionId,
          workDir
        )
        return { agent, response: result }
      } catch {
        try {
          const response = await callLLMForAnalysis(prompt)
          return { agent, response }
        } catch {
          return { agent, response: '[问答失败]' }
        }
      }
    })
  )

  const questions: Array<{ agentName: string; content: string }> = []
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { agent, response } = r.value
      if (response.trim() !== '无问题') {
        questions.push({ agentName: agent.name, content: response })
      }
    }
  }

  if (questions.length > 0) {
    for (const q of questions) {
      await prisma.message.create({ data: { role: 'agent', rawContent: q.content, sessionId, agentId: q.agentName } })
      sendEvent({ agentId: q.agentName, type: 'done', content: q.content })
    }
    sendEvent({ agentId: 'orchestrator', type: 'awaiting_user_input', content: 'agent_qa' })
  } else {
    sendEvent({ agentId: 'orchestrator', type: 'text', content: '所有 Agent 无疑问，开始执行...' })
    await transitionToExecution(sessionId, agents, sendEvent)
  }
}

export async function transitionToExecution(
  sessionId: string,
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string; tools: string }>,
  sendEvent: SendEvent,
  userMessage?: string,
  orchSessionId?: string
) {
  await prisma.session.update({ where: { id: sessionId }, data: { phase: 'execution', phaseStep: '' } })
  sendEvent({ agentId: 'orchestrator', type: 'phase_transition', content: 'execution' })

  // 兜底：Task 为空时自动补拆（Orchestrator 可能跳过了 align_decompose）
  const existingTasks = await prisma.task.findMany({ where: { sessionId } })
  if (existingTasks.length === 0) {
    sendEvent({ agentId: 'orchestrator', type: 'status', content: '任务列表为空，正在自动拆解...' })
    await handleArchitectPlan(userMessage || '', sessionId, agents, sendEvent)
  }

  sendEvent({ agentId: 'orchestrator', type: 'awaiting_user_input', content: '' })
  await handleExecution(userMessage || '', sessionId, agents, sendEvent, orchSessionId)
}

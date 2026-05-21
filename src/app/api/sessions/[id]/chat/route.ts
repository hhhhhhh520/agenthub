import { prisma } from '@/lib/db'
import { executeTaskBatch, runDiscussion, executeSingleAgent, callLLMForAnalysis } from '@/lib/orchestrator'
import { PM_CONFIRMATION_PROMPT, buildAgentQuestionPrompt } from '@/lib/orchestrator/prompts'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params
  const { message, mentionAll, targetAgent, replyToId, regenerate } = await request.json()

  // Fetch session with phase info
  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  if (!session) {
    return new Response('Session not found', { status: 404 })
  }

  // If regenerate, don't create a new user message
  if (!regenerate) {
    await prisma.message.create({
      data: { role: 'user', rawContent: message, sessionId, replyToId },
    })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      function sendEvent(data: { agentId: string; type: string; content: string; messageId?: string }) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      }

      try {
        const existingMembers = await prisma.sessionMember.findMany({
          where: { sessionId },
          include: { agent: true },
        })
        const existingAgents = existingMembers.map(m => m.agent)

        if (regenerate) {
          const original = await prisma.message.findUnique({ where: { id: regenerate } })
          if (!original || original.sessionId !== sessionId) {
            sendEvent({ agentId: 'orchestrator', type: 'error', content: '原消息不存在' })
          } else {
            const agent = original.agentId ? existingAgents.find(a => a.name === original.agentId) : null
            const agentName = agent?.name || 'orchestrator'
            sendEvent({ agentId: agentName, type: 'status', content: '重新生成中...' })

            const result = await executeSingleAgent(
              { name: agentName, systemPrompt: agent?.systemPrompt || '', platform: agent?.platform || 'llm' },
              original.rawContent,
              '',
              (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content })
            )

            await prisma.message.update({
              where: { id: regenerate },
              data: { rawContent: result },
            })
            sendEvent({ agentId: agentName, type: 'done', content: result, messageId: regenerate })
          }
        } else if (mentionAll && existingAgents.length > 0) {
          sendEvent({ agentId: 'orchestrator', type: 'status', content: '开始多轮讨论...' })

          const opinions = await runDiscussion(
            message,
            existingAgents.map(a => ({ name: a.name, systemPrompt: a.systemPrompt })),
            3,
            (agentName, chunk) => sendEvent({ agentId: agentName, type: chunk.type, content: chunk.content })
          )

          const summary = opinions.join('\n\n')
          await prisma.message.create({
            data: { role: 'orchestrator', rawContent: summary, sessionId },
          })
          sendEvent({ agentId: 'orchestrator', type: 'done', content: summary })
        } else if (targetAgent) {
          const agent = existingAgents.find(a => a.name === targetAgent)
          if (!agent) {
            sendEvent({ agentId: 'orchestrator', type: 'error', content: `未找到名为 ${targetAgent} 的 Agent` })
          } else {
            sendEvent({ agentId: agent.name, type: 'status', content: '执行中...' })
            const result = await executeSingleAgent(
              { name: agent.name, systemPrompt: agent.systemPrompt, platform: agent.platform },
              message,
              '',
              (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content })
            )
            await prisma.message.create({
              data: { role: 'agent', rawContent: result, sessionId, agentId: agent.name },
            })
            sendEvent({ agentId: agent.name, type: 'done', content: result })
          }
        } else {
          // Check for agent creation intent
          const isCreateIntent = /创建|新建|添加|帮我建|create\s*agent/i.test(message)

          if (isCreateIntent) {
            await handleCreateAgent(message, sessionId, sendEvent, controller)
          } else if (session.phase === 'idle' && isTaskIntent(message)) {
            // Task detected: start alignment
            await handlePMConfirmation(message, sessionId, existingAgents, sendEvent)
          } else if (session.phase === 'idle' || (session.phase === 'alignment' && session.phaseStep === '')) {
            // Normal chat with Orchestrator
            await handleOrchestratorChat(message, sessionId, sendEvent)
          } else if (session.phase === 'alignment') {
            if (session.phaseStep === 'pm_confirm') {
              await handleArchitectPlan(message, sessionId, existingAgents, sendEvent)
            } else if (session.phaseStep === 'architect_plan') {
              await handleAgentQA(message, sessionId, existingAgents, sendEvent)
            } else if (session.phaseStep === 'agent_qa') {
              // User answered agent questions, transition to execution
              await prisma.session.update({
                where: { id: sessionId },
                data: { phase: 'execution', phaseStep: '' },
              })
              sendEvent({ agentId: 'orchestrator', type: 'text', content: '对齐完成，进入执行阶段' })
              sendEvent({ agentId: 'orchestrator', type: 'phase_transition', content: 'execution' })
              await handleExecution(message, sessionId, existingAgents, sendEvent)
            }
          } else if (session.phase === 'execution') {
            // Execute tasks with dependency gating
            await handleExecution(message, sessionId, existingAgents, sendEvent)
          }
        }
      } catch (error) {
        sendEvent({ agentId: 'orchestrator', type: 'error', content: String(error) })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}

// ─── Task Intent Detection ─────────────────────────────
function isTaskIntent(message: string): boolean {
  return /开发|实现|做一?个|写一?个|帮我做|帮我写|帮我实现|搭建|重构|修复|优化|创建项目|implement|build|create/i.test(message)
}

// ─── Normal Orchestrator Chat ──────────────────────────
async function handleOrchestratorChat(
  message: string,
  sessionId: string,
  sendEvent: (data: { agentId: string; type: string; content: string }) => void
) {
  sendEvent({ agentId: 'orchestrator', type: 'status', content: '思考中...' })

  const result = await executeSingleAgent(
    { name: 'Orchestrator', systemPrompt: '你是 AgentHub 的 Orchestrator，一个多 Agent 协作平台的协调者。你可以和用户闲聊、回答问题、解释功能。当用户下达开发任务时，你会启动对齐流程（PM确认→架构师方案→Agent Q&A→执行）。现在请友好地回复用户。', platform: 'claude-code' },
    message,
    '',
    (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content })
  )

  await prisma.message.create({
    data: { role: 'orchestrator', rawContent: result, sessionId },
  })
  sendEvent({ agentId: 'orchestrator', type: 'done', content: result })
}

// ─── Agent Creation ───────────────────────────────────
async function handleCreateAgent(
  message: string,
  sessionId: string,
  sendEvent: (data: { agentId: string; type: string; content: string }) => void,
  controller: ReadableStreamDefaultController
) {
  sendEvent({ agentId: 'orchestrator', type: 'status', content: '正在生成 Agent 配置...' })

  const configPrompt = `从用户消息中提取 Agent 配置，返回 JSON（不要其他话）：
{"name":"角色名","expertise":"专长描述","systemPrompt":"系统提示词","platform":"llm或claude-code","capabilities":["标签1","标签2"],"accentColor":"#hex色"}

用户消息：${message}`

  const configText = await callLLMForAnalysis(configPrompt)
  const cleaned = configText.replace(/```json?\s*([\s\S]*?)```/, '$1').trim()
  let config: { name: string; expertise: string; systemPrompt: string; platform?: string; capabilities?: string[]; accentColor?: string }
  try {
    config = JSON.parse(cleaned)
  } catch {
    sendEvent({ agentId: 'orchestrator', type: 'error', content: 'Agent 配置解析失败，请重试' })
    controller.close()
    return
  }

  const agent = await prisma.agent.create({
    data: {
      name: config.name,
      expertise: config.expertise,
      systemPrompt: config.systemPrompt,
      platform: config.platform || 'llm',
      capabilities: JSON.stringify(config.capabilities || []),
      accentColor: config.accentColor || '#6366f1',
      isPreset: false,
    },
  })

  await prisma.sessionMember.create({
    data: { sessionId, agentId: agent.id },
  })

  const result = `已创建 Agent「${agent.name}」\n专长：${agent.expertise}\n平台：${agent.platform}`
  await prisma.message.create({
    data: { role: 'orchestrator', rawContent: result, sessionId },
  })
  sendEvent({ agentId: 'orchestrator', type: 'text', content: result })
  sendEvent({ agentId: 'orchestrator', type: 'done', content: result })
}

// ─── Phase 1: PM Confirmation ─────────────────────────
async function handlePMConfirmation(
  message: string,
  sessionId: string,
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string }>,
  sendEvent: (data: { agentId: string; type: string; content: string }) => void
) {
  const pmAgent = agents.find(a => a.name.includes('产品') || a.name.includes('PM'))
  if (!pmAgent) {
    sendEvent({ agentId: 'orchestrator', type: 'error', content: '没有产品经理 Agent，请先创建或添加' })
    return
  }

  sendEvent({ agentId: 'orchestrator', type: 'status', content: '产品经理确认需求中...' })

  const prompt = PM_CONFIRMATION_PROMPT.replace('{userMessage}', message)
  const result = await executeSingleAgent(
    { name: pmAgent.name, systemPrompt: pmAgent.systemPrompt, platform: pmAgent.platform },
    prompt,
    '',
    (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content })
  )

  await prisma.message.create({
    data: { role: 'agent', rawContent: result, sessionId, agentId: pmAgent.name },
  })
  sendEvent({ agentId: pmAgent.name, type: 'done', content: result })

  // Update session phase
  await prisma.session.update({
    where: { id: sessionId },
    data: { phase: 'alignment', phaseStep: 'pm_confirm' },
  })
  sendEvent({ agentId: 'orchestrator', type: 'awaiting_user_input', content: 'pm_confirm' })
}

// ─── Phase 2: Architect Plan ──────────────────────────
async function handleArchitectPlan(
  message: string,
  sessionId: string,
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string }>,
  sendEvent: (data: { agentId: string; type: string; content: string }) => void
) {
  const architect = agents.find(a => a.name.includes('架构'))
  if (!architect) {
    sendEvent({ agentId: 'orchestrator', type: 'error', content: '没有架构师 Agent，请先创建或添加' })
    return
  }

  sendEvent({ agentId: 'orchestrator', type: 'status', content: '架构师出方案中...' })

  // Get the original user message (first message in session)
  const firstMsg = await prisma.message.findFirst({
    where: { sessionId, role: 'user' },
    orderBy: { createdAt: 'asc' },
  })
  const userMessage = firstMsg?.rawContent || message

  const agentList = agents.map(a => `${a.name}（${a.expertise}）`).join('、')
  const prompt = `根据以下需求，给出技术方案并拆解任务。

需求：${userMessage}
用户补充：${message}

可用角色：${agentList}

每个子任务需要：
- id: 序号（从 1 开始）
- description: 任务描述（一句话，明确产出物）
- assignedAgent: 负责的 Agent 名称
- dependencies: 依赖的任务序号数组
- declared_files: 预期修改的文件路径列表

规则：
- 一个任务 = 一个 Agent = 一个明确的产出
- 无依赖的任务可并行执行
- 有重叠文件的任务必须设为串行依赖

返回 JSON：
{
  "techStack": "技术方案概述",
  "tasks": [
    { "id": 1, "description": "...", "assignedAgent": "...", "dependencies": [], "declared_files": ["src/..."] }
  ]
}`

  const result = await executeSingleAgent(
    { name: architect.name, systemPrompt: architect.systemPrompt, platform: architect.platform },
    prompt,
    '',
    (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content })
  )

  await prisma.message.create({
    data: { role: 'agent', rawContent: result, sessionId, agentId: architect.name },
  })
  sendEvent({ agentId: architect.name, type: 'done', content: result })

  // Parse tasks from architect response
  try {
    const cleaned = result.replace(/```json?\s*([\s\S]*?)```/, '$1').trim()
    // Find JSON object in the response
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      if (parsed.tasks && Array.isArray(parsed.tasks)) {
        const idMap = new Map<number, string>()
        parsed.tasks.forEach((t: { id: number }) => idMap.set(t.id, crypto.randomUUID()))

        for (const task of parsed.tasks) {
          await prisma.task.create({
            data: {
              id: idMap.get(task.id)!,
              description: task.description,
              sessionId,
              assignedAgentId: agents.find(a => a.name === task.assignedAgent)?.id,
              dependencies: JSON.stringify((task.dependencies || []).map((d: number) => idMap.get(d)!).filter(Boolean)),
              declaredFiles: JSON.stringify(task.declared_files || []),
            },
          })
        }
        sendEvent({ agentId: 'orchestrator', type: 'text', content: `已拆解为 ${parsed.tasks.length} 个子任务` })
      }
    }
  } catch {
    sendEvent({ agentId: 'orchestrator', type: 'error', content: '任务拆解解析失败，请重试' })
    return
  }

  // Update phase step
  await prisma.session.update({
    where: { id: sessionId },
    data: { phaseStep: 'architect_plan' },
  })
  sendEvent({ agentId: 'orchestrator', type: 'awaiting_user_input', content: 'architect_plan' })
}

// ─── Phase 3: Agent Q&A ───────────────────────────────
async function handleAgentQA(
  message: string,
  sessionId: string,
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string }>,
  sendEvent: (data: { agentId: string; type: string; content: string }) => void
) {
  // Get the original user message and architect plan
  const messages = await prisma.message.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  })
  const userMessage = messages.find(m => m.role === 'user')?.rawContent || ''
  const architectPlan = messages.filter(m => m.agentId?.includes('架构')).map(m => m.rawContent).join('\n') || ''

  const otherAgents = agents.filter(a => !a.name.includes('产品') && !a.name.includes('架构') && !a.name.includes('PM'))

  if (otherAgents.length === 0) {
    // No other agents, transition directly to execution
    await prisma.session.update({
      where: { id: sessionId },
      data: { phase: 'execution', phaseStep: '' },
    })
    sendEvent({ agentId: 'orchestrator', type: 'text', content: '对齐完成，进入执行阶段' })
    sendEvent({ agentId: 'orchestrator', type: 'phase_transition', content: 'execution' })
    return
  }

  sendEvent({ agentId: 'orchestrator', type: 'status', content: '其他 Agent 提问中...' })

  const questions: string[] = []
  for (const agent of otherAgents) {
    const prompt = buildAgentQuestionPrompt(agent.name, agent.expertise, userMessage, architectPlan)
    const result = await executeSingleAgent(
      { name: agent.name, systemPrompt: agent.systemPrompt, platform: agent.platform },
      prompt,
      '',
      (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content })
    )

    await prisma.message.create({
      data: { role: 'agent', rawContent: result, sessionId, agentId: agent.name },
    })
    sendEvent({ agentId: agent.name, type: 'done', content: result })

    if (result !== '无问题' && !result.includes('无问题')) {
      questions.push(`${agent.name}：${result}`)
    }
  }

  if (questions.length > 0) {
    // Agents have questions, wait for user response
    await prisma.session.update({
      where: { id: sessionId },
      data: { phaseStep: 'agent_qa' },
    })
    sendEvent({ agentId: 'orchestrator', type: 'awaiting_user_input', content: 'agent_qa' })
  } else {
    // All agents said "无问题", transition to execution
    await prisma.session.update({
      where: { id: sessionId },
      data: { phase: 'execution', phaseStep: '' },
    })
    sendEvent({ agentId: 'orchestrator', type: 'text', content: '对齐完成，进入执行阶段' })
    sendEvent({ agentId: 'orchestrator', type: 'phase_transition', content: 'execution' })
  }
}

// ─── Phase 4: Execution ───────────────────────────────
async function handleExecution(
  message: string,
  sessionId: string,
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string }>,
  sendEvent: (data: { agentId: string; type: string; content: string }) => void
) {
  // Get all tasks for this session
  const tasks = await prisma.task.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  })

  if (tasks.length === 0) {
    sendEvent({ agentId: 'orchestrator', type: 'error', content: '没有待执行的任务' })
    return
  }

  // Get the original user message for context
  const firstMsg = await prisma.message.findFirst({
    where: { sessionId, role: 'user' },
    orderBy: { createdAt: 'asc' },
  })
  const context = firstMsg?.rawContent || message

  const agentMap = new Map(agents.map(a => [a.name, a]))

  // Execute tasks with dependency gating
  const allResults = new Map<string, string>()
  let hasProgress = true

  while (hasProgress) {
    hasProgress = false

    // Find tasks that are pending and have all dependencies completed
    const readyTasks = tasks.filter(t => {
      if (t.status !== 'pending') return false
      const deps: string[] = JSON.parse(t.dependencies || '[]')
      return deps.every(depId => {
        const dep = tasks.find(t2 => t2.id === depId)
        return dep?.status === 'completed'
      })
    })

    if (readyTasks.length === 0) break

    // Mark ready tasks as in_progress
    for (const task of readyTasks) {
      await prisma.task.update({ where: { id: task.id }, data: { status: 'in_progress' } })
      task.status = 'in_progress'
      sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId: task.id, status: 'in_progress' }) })
    }

    // Execute ready tasks in parallel
    let results: Map<string, string>
    try {
      results = await executeTaskBatch(
        readyTasks.map(t => ({
          id: t.id,
          description: t.description,
          assignedAgent: agents.find(a => a.id === t.assignedAgentId)?.name || '',
          dependencies: JSON.parse(t.dependencies || '[]'),
          declaredFiles: JSON.parse(t.declaredFiles || '[]'),
          batch: 0,
        })),
        agents.map(a => ({ name: a.name, systemPrompt: a.systemPrompt, platform: a.platform })),
        context,
        (taskId, chunk) => sendEvent({ agentId: taskId, type: chunk.type, content: chunk.content })
      )
    } catch {
      // Mark all ready tasks as failed
      for (const task of readyTasks) {
        await prisma.task.update({ where: { id: task.id }, data: { status: 'failed' } })
        task.status = 'failed'
        sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId: task.id, status: 'failed' }) })
      }
      results = new Map()
    }

    // Update task statuses
    for (const [taskId, result] of results) {
      allResults.set(taskId, result)
      await prisma.task.update({ where: { id: taskId }, data: { status: 'completed' } })
      const task = tasks.find(t => t.id === taskId)
      if (task) task.status = 'completed'
      sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId, status: 'completed' }) })
      hasProgress = true
    }

    // Check for blocked tasks (pending with failed dependencies)
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

  // Check if all tasks are done
  const allDone = tasks.every(t => t.status === 'completed' || t.status === 'blocked')
  if (allDone) {
    await prisma.session.update({ where: { id: sessionId }, data: { phase: 'done', phaseStep: '' } })
  }

  const summary = Array.from(allResults.entries())
    .map(([taskId, result]) => `任务完成：${result.slice(0, 100)}...`)
    .join('\n')
  if (summary) {
    await prisma.message.create({
      data: { role: 'orchestrator', rawContent: summary, sessionId },
    })
    sendEvent({ agentId: 'orchestrator', type: 'done', content: summary })
  } else {
    sendEvent({ agentId: 'orchestrator', type: 'done', content: '所有任务已完成' })
  }
}

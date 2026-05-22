import { join } from 'path'
import { prisma } from '@/lib/db'
import { executeTaskBatch, runDiscussion, executeSingleAgent, callLLMForAnalysis, analyzeScene, getOrchestratorDecision, parseJSON } from '@/lib/orchestrator'
import { PM_CONFIRMATION_PROMPT, buildAgentQuestionPrompt, buildMonitoringPrompt } from '@/lib/orchestrator/prompts'
import { enforceFileOverlap } from '@/lib/orchestrator/scheduler'
import { ensureWorkspaceRoot, createTaskWorkspace, takeSnapshot, auditTaskWorkspace, cleanupTaskWorkspaces } from '@/lib/workspace'

// Per-session lock: ensures chat requests for the same session are processed serially
const sessionLocks = new Map<string, Promise<void>>()

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params

  // Wait for any in-flight request for this session to finish
  const prev = sessionLocks.get(sessionId) || Promise.resolve()
  let release: () => void
  const current = new Promise<void>(r => { release = r })
  sessionLocks.set(sessionId, current)
  await prev
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

            const workDir = join(process.cwd(), 'workspaces', sessionId)
            const { result, sessionId: cliSessionId } = await executeSingleAgent(
              { name: agentName, systemPrompt: agent?.systemPrompt || '', platform: agent?.platform || 'llm', model: agent?.model, baseUrl: agent?.baseUrl, apiKey: agent?.apiKey, workDir },
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
            existingAgents.map(a => ({ name: a.name, systemPrompt: a.systemPrompt, platform: a.platform, model: a.model, baseUrl: a.baseUrl, apiKey: a.apiKey })),
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
            // Build context from session history
            const history = await prisma.message.findMany({
              where: { sessionId },
              orderBy: { createdAt: 'asc' },
              take: 20,
            })
            const context = history.map(m => {
              const who = m.role === 'user' ? '用户' : m.role === 'orchestrator' ? 'Orchestrator' : (m.agentId || 'Agent')
              return `[${who}]: ${m.rawContent.slice(0, 500)}`
            }).join('\n')

            sendEvent({ agentId: agent.name, type: 'status', content: '执行中...' })
            const workDir = join(process.cwd(), 'workspaces', sessionId)
            const { result, sessionId: cliSessionId } = await executeSingleAgent(
              { name: agent.name, systemPrompt: agent.systemPrompt, platform: agent.platform, model: agent.model, baseUrl: agent.baseUrl, apiKey: agent.apiKey, workDir },
              message,
              context,
              (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content })
            )
            await prisma.message.create({
              data: { role: 'agent', rawContent: result, sessionId, agentId: agent.name },
            })
            sendEvent({ agentId: agent.name, type: 'done', content: result })
          }
        } else if (session.type === 'private' && existingAgents.length > 0) {
          // Private chat: direct 1v1 with the agent
          const agent = existingAgents[0]
          try {
            sendEvent({ agentId: agent.name, type: 'status', content: '思考中...' })
            const workDir = join(process.cwd(), 'workspaces', sessionId)
            const { result, sessionId: cliSessionId } = await executeSingleAgent(
              { name: agent.name, systemPrompt: agent.systemPrompt, platform: agent.platform, model: agent.model, baseUrl: agent.baseUrl, apiKey: agent.apiKey, workDir },
              message,
              '',
              (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content })
            )
            await prisma.message.create({
              data: { role: 'agent', rawContent: result, sessionId, agentId: agent.name },
            })
            sendEvent({ agentId: agent.name, type: 'done', content: result })
          } catch (err) {
            sendEvent({ agentId: agent.name, type: 'error', content: `执行失败: ${err instanceof Error ? err.message : String(err)}` })
          }
        } else {
          // Check for agent creation intent (must check before Orchestrator decision)
          const isCreateIntent = /创建|新建|添加|帮我建|create.*agent|建一?个/i.test(message) && /agent|智能体|助手/i.test(message)

          if (isCreateIntent) {
            await handleCreateAgent(message, sessionId, sendEvent)
          } else {
            // Orchestrator 自主决策模式
            await handleOrchestratorDecision(message, sessionId, existingAgents, sendEvent)
          }
        }
      } catch (error) {
        sendEvent({ agentId: 'orchestrator', type: 'error', content: String(error) })
      } finally {
        controller.close()
        release()
        // Clean up lock if this is still the current holder
        if (sessionLocks.get(sessionId) === current) sessionLocks.delete(sessionId)
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

// ─── Orchestrator Decision Mode ────────────────────────
async function handleOrchestratorDecision(
  message: string,
  sessionId: string,
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string }>,
  sendEvent: (data: { agentId: string; type: string; content: string }) => void
) {
  sendEvent({ agentId: 'orchestrator', type: 'status', content: '思考中...' })

  // 获取对话历史作为上下文
  const history = await prisma.message.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
    take: 20,
  })
  const context = history.map(m => {
    const who = m.role === 'user' ? '用户' : m.role === 'orchestrator' ? 'Orchestrator' : (m.agentId || 'Agent')
    return `[${who}]: ${m.rawContent.slice(0, 500)}`
  }).join('\n')

  // Orchestrator 自主决策
  const decision = await getOrchestratorDecision(
    message,
    agents.map(a => ({ name: a.name, expertise: a.expertise, platform: a.platform })),
    context
  )

  sendEvent({ agentId: 'orchestrator', type: 'text', content: `[决策] ${decision.reason}` })

  switch (decision.action) {
    case 'self':
      // Orchestrator 自己回答
      await handleOrchestratorChat(message, sessionId, sendEvent, agents)
      break

    case 'delegate':
      // 委派给指定 Agent
      if (decision.target) {
        await delegateToAgent(decision.target, decision.message || message, sessionId, agents, sendEvent)
      }
      break

    case 'discuss':
      // 多 Agent 讨论
      if (decision.targets && decision.targets.length > 0) {
        await runMultiAgentDiscussion(decision.targets, decision.message || message, sessionId, agents, sendEvent)
      }
      break

    case 'done':
      // 任务完成
      await prisma.session.update({
        where: { id: sessionId },
        data: { phase: 'done', phaseStep: '' },
      })
      sendEvent({ agentId: 'orchestrator', type: 'text', content: decision.message || '任务已完成' })
      sendEvent({ agentId: 'orchestrator', type: 'done', content: decision.message || '任务已完成' })
      break
  }
}

// ─── Delegate to Specific Agent ────────────────────────
async function delegateToAgent(
  agentName: string,
  taskMessage: string,
  sessionId: string,
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string }>,
  sendEvent: (data: { agentId: string; type: string; content: string }) => void
) {
  const agent = agents.find(a => a.name === agentName)
  if (!agent) {
    sendEvent({ agentId: 'orchestrator', type: 'error', content: `未找到名为 ${agentName} 的 Agent` })
    return
  }

  sendEvent({ agentId: agent.name, type: 'status', content: '执行中...' })

  // 获取对话历史作为上下文
  const history = await prisma.message.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
    take: 20,
  })
  const context = history.map(m => {
    const who = m.role === 'user' ? '用户' : m.role === 'orchestrator' ? 'Orchestrator' : (m.agentId || 'Agent')
    return `[${who}]: ${m.rawContent.slice(0, 500)}`
  }).join('\n')

  // 使用项目的 workspaces 目录作为工作目录
  const workDir = join(process.cwd(), 'workspaces', sessionId)

  const { result, sessionId: cliSessionId } = await executeSingleAgent(
    { name: agent.name, systemPrompt: agent.systemPrompt, platform: agent.platform, model: agent.model, baseUrl: agent.baseUrl, apiKey: agent.apiKey, workDir },
    taskMessage,
    context,
    (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content })
  )

  await prisma.message.create({
    data: { role: 'agent', rawContent: result, sessionId, agentId: agent.name },
  })
  sendEvent({ agentId: agent.name, type: 'done', content: result })
}

// ─── Multi-Agent Discussion ────────────────────────────
async function runMultiAgentDiscussion(
  agentNames: string[],
  topic: string,
  sessionId: string,
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string }>,
  sendEvent: (data: { agentId: string; type: string; content: string }) => void
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

  const opinions = await runDiscussion(
    topic,
    discussionAgents,
    3,
    (agentName, chunk) => sendEvent({ agentId: agentName, type: chunk.type, content: chunk.content })
  )

  const summary = opinions.join('\n\n')
  await prisma.message.create({
    data: { role: 'orchestrator', rawContent: summary, sessionId },
  })
  sendEvent({ agentId: 'orchestrator', type: 'done', content: summary })
}

// ─── Normal Orchestrator Chat ──────────────────────────
async function handleOrchestratorChat(
  message: string,
  sessionId: string,
  sendEvent: (data: { agentId: string; type: string; content: string }) => void,
  agents?: Array<{ name: string; expertise: string; platform: string }>
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

  const workDir = join(process.cwd(), 'workspaces', sessionId)
  const { result } = await executeSingleAgent(
    { name: 'Orchestrator', systemPrompt, platform: 'claude-code', workDir },
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
  sendEvent: (data: { agentId: string; type: string; content: string }) => void
) {
  sendEvent({ agentId: 'orchestrator', type: 'status', content: '正在生成 Agent 配置...' })

  const configPrompt = `从用户消息中提取 Agent 配置，返回 JSON（不要其他话）：
{"name":"角色名","expertise":"专长描述","systemPrompt":"系统提示词","platform":"llm或claude-code","capabilities":["标签1","标签2"],"accentColor":"#hex色"}

用户消息：${message}`

  const configText = await callLLMForAnalysis(configPrompt)
  let config: { name: string; expertise: string; systemPrompt: string; platform?: string; capabilities?: string[]; accentColor?: string }
  try {
    config = parseJSON(configText)
  } catch {
    sendEvent({ agentId: 'orchestrator', type: 'error', content: 'Agent 配置解析失败，请重试' })
    return
  }

  // 检查名称是否已存在
  const existing = await prisma.agent.findUnique({ where: { name: config.name } })
  if (existing) {
    // 名称冲突，自动加后缀
    const suffix = Date.now().toString(36).slice(-4)
    config.name = `${config.name}_${suffix}`
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

// ─── Phase 4: Execution ───────────────────────────────
async function handleExecution(
  message: string,
  sessionId: string,
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string }>,
  sendEvent: (data: { agentId: string; type: string; content: string }) => void
) {
  const tasks = await prisma.task.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  })

  if (tasks.length === 0) {
    sendEvent({ agentId: 'orchestrator', type: 'error', content: '没有待执行的任务' })
    return
  }

  // 6.1: Full chat history as context
  const allMessages = await prisma.message.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  })
  const context = allMessages
    .map(m => {
      const speaker = m.role === 'user' ? '用户' : m.role === 'orchestrator' ? 'Orchestrator' : m.agentId || 'Agent'
      return `[${speaker}]: ${m.rawContent.slice(0, 500)}`
    })
    .join('\n\n')

  // 6.5c: Prepare workspaces
  ensureWorkspaceRoot()
  takeSnapshot(sessionId)

  // 6.3a: Enforce file overlap (inject serial dependencies)
  const scheduledTasks = tasks.map(t => ({
    id: t.id,
    description: t.description,
    assignedAgent: agents.find(a => a.id === t.assignedAgentId)?.name || '',
    dependencies: JSON.parse(t.dependencies || '[]') as string[],
    declaredFiles: JSON.parse(t.declaredFiles || '[]') as string[],
    batch: 0,
  }))
  enforceFileOverlap(scheduledTasks)

  // Update dependencies in DB if changed
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

  while (hasProgress) {
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

    // 6.5c: Create workspaces for ready tasks
    const workspacePaths = new Map<string, string>()
    const failedTaskIds = new Set<string>()
    for (const task of readyTasks) {
      try {
        const wsPath = createTaskWorkspace(sessionId, task.id)
        workspacePaths.set(task.id, wsPath)
        await prisma.task.update({ where: { id: task.id }, data: { status: 'in_progress', workspacePath: wsPath } })
        task.status = 'in_progress'
        sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId: task.id, status: 'in_progress' }) })
      } catch {
        await prisma.task.update({ where: { id: task.id }, data: { status: 'failed' } })
        task.status = 'failed'
        failedTaskIds.add(task.id)
        sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId: task.id, status: 'failed' }) })
      }
    }

    // Execute ready tasks in parallel
    let results: Map<string, { result: string; sessionId?: string }>
    try {
      results = await executeTaskBatch(
        readyTasks.map(t => ({
          id: t.id,
          description: t.description,
          assignedAgent: agents.find(a => a.id === t.assignedAgentId)?.name || '',
          dependencies: JSON.parse(t.dependencies || '[]'),
          declaredFiles: JSON.parse(t.declaredFiles || '[]'),
          workspacePath: workspacePaths.get(t.id),
          batch: 0,
        })),
        agents.map(a => ({ name: a.name, systemPrompt: a.systemPrompt, platform: a.platform, model: a.model, baseUrl: a.baseUrl, apiKey: a.apiKey })),
        context,
        (taskId, chunk) => sendEvent({ agentId: taskId, type: chunk.type, content: chunk.content })
      )
    } catch {
      for (const task of readyTasks) {
        await prisma.task.update({ where: { id: task.id }, data: { status: 'failed' } })
        task.status = 'failed'
        sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId: task.id, status: 'failed' }) })
      }
      results = new Map()
    }

    // Update task statuses + persist sessionId + audit
    for (const [taskId, { result, sessionId: cliSessionId }] of results) {
      allResults.set(taskId, result)
      // 持久化 CLI sessionId
      await prisma.task.update({
        where: { id: taskId },
        data: { status: 'completed', cliSessionId: cliSessionId || null },
      })
      const task = tasks.find(t => t.id === taskId)
      if (task) task.status = 'completed'
      sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId, status: 'completed' }) })
      hasProgress = true

      // 6.4b: Merge audit
      const declaredFiles: string[] = JSON.parse(task?.declaredFiles || '[]')
      const audit = auditTaskWorkspace(sessionId, taskId, declaredFiles)
      if (audit.undeclared.length > 0) {
        for (const filePath of audit.undeclared) {
          const diffContent = `<!-- artifact:diff filePath=${filePath} -->
${filePath}
<!-- /artifact -->`
          const msg = `[越界修改] 任务 ${taskId} 未声明修改了 ${filePath}:\n${diffContent}`
          await prisma.message.create({ data: { role: 'orchestrator', rawContent: msg, sessionId } })
          sendEvent({ agentId: 'orchestrator', type: 'text', content: msg })
        }
      } else {
        sendEvent({ agentId: 'orchestrator', type: 'text', content: `任务 ${taskId} 完成，所有修改均在声明范围内` })
      }

      // 6.2b: Orchestrator monitoring (only for CLI agents)
      const agent = agents.find(a => a.id === task?.assignedAgentId)
      if (agent?.platform !== 'llm') {
        try {
          const monitoringPrompt = buildMonitoringPrompt(task?.description || '', result, declaredFiles, audit)
          const reviewResult = await callLLMForAnalysis(monitoringPrompt)
          const cleaned = reviewResult.replace(/```json?\s*([\s\S]*?)```/, '$1').trim()
          const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
          if (jsonMatch) {
            const review = JSON.parse(jsonMatch[0])
            if (review.needsCorrection && review.correctionNote) {
              const correctionMsg = `Orchestrator 纠偏：任务 "${task?.description}" ${review.correctionNote}`
              await prisma.message.create({ data: { role: 'orchestrator', rawContent: correctionMsg, sessionId } })
              sendEvent({ agentId: 'orchestrator', type: 'text', content: correctionMsg })
            }
          }
        } catch { /* monitoring failed, continue */ }
      }
    }

    // Check for blocked tasks
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
    // 6.5e: Cleanup workspaces
    cleanupTaskWorkspaces(sessionId)
  }

  const summary = Array.from(allResults.entries())
    .map(([taskId, result]) => `任务完成：${result.slice(0, 100)}...`)
    .join('\n')
  if (summary) {
    await prisma.message.create({ data: { role: 'orchestrator', rawContent: summary, sessionId } })
    sendEvent({ agentId: 'orchestrator', type: 'done', content: summary })
  } else {
    sendEvent({ agentId: 'orchestrator', type: 'done', content: '所有任务已完成' })
  }
}

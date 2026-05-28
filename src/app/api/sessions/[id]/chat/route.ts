import { join } from 'path'
import { prisma } from '@/lib/db'

const DIR_SLUGS: Record<string, string> = {
  '前端工程师': 'frontend', '后端工程师': 'backend', '测试工程师': 'test',
  '架构师': 'architect', '产品经理': 'product', 'UI 设计师': 'designer',
  'Orchestrator': 'orchestrator',
}
import { executeTaskBatch, runDiscussion, executeSingleAgent, callLLMForAnalysis, getOrchestratorDecision, parseJSON, analyzeScene, generateRoles, decomposeTasks, formatArchitectPlan, getOrchestratorAgent } from '@/lib/orchestrator'
import { buildMonitoringPrompt, PM_CONFIRMATION_PROMPT, buildAgentQuestionPrompt } from '@/lib/orchestrator/prompts'
import { enforceFileOverlap, topologicalSort, type ScheduledTask } from '@/lib/orchestrator/scheduler'
import { execSync } from 'child_process'
import { parseMessage } from '@/lib/message-parser'

function getChangedFiles(projectDir: string, before: Set<string>): string[] {
  try {
    const after = execSync('git diff --name-only HEAD', { cwd: projectDir, encoding: 'utf-8', timeout: 5000 })
      .trim().split('\n').filter(Boolean)
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: projectDir, encoding: 'utf-8', timeout: 5000 })
      .trim().split('\n').filter(Boolean)
    const all = new Set([...after, ...untracked])
    return [...all].filter(f => !before.has(f))
  } catch {
    return []
  }
}

function getGitSnapshot(projectDir: string): Set<string> {
  try {
    const tracked = execSync('git diff --name-only HEAD', { cwd: projectDir, encoding: 'utf-8', timeout: 5000 })
      .trim().split('\n').filter(Boolean)
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: projectDir, encoding: 'utf-8', timeout: 5000 })
      .trim().split('\n').filter(Boolean)
    return new Set([...tracked, ...untracked])
  } catch {
    return new Set()
  }
}

// Design decision #11: structured context with code/artifact markers
function buildContextFromHistory(history: Array<{ role: string; agentId?: string | null; rawContent: string }>): string {
  return history.map(m => {
    const role = m.role === 'user' ? 'User' : m.agentId || 'Agent'
    const parsed = parseMessage(m.rawContent)
    let content = parsed.text
    if (parsed.codeBlocks.length > 0) {
      content += '\n\n[代码块]\n' + parsed.codeBlocks.map(b => '```' + (b.language || '') + '\n' + b.code + '\n```').join('\n')
    }
    if (parsed.artifacts.length > 0) {
      content += '\n\n[工件: ' + parsed.artifacts.map(a => a.meta.filePath || a.type).join(', ') + ']'
    }
    return `--- ${role} ---\n${content}`
  }).join('\n\n')
}

// Per-session lock: ensures chat requests for the same session are processed serially
const sessionLocks = new Map<string, Promise<void>>()
const LOCK_TIMEOUT_MS = 60_000 // 60 seconds

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params

  // Wait for any in-flight request for this session to finish (with timeout)
  let release: () => void
  const current = new Promise<void>(r => { release = r })
  const prev = sessionLocks.get(sessionId) || Promise.resolve()
  sessionLocks.set(sessionId, current)

  // Timeout guard: if previous request hangs, just stop waiting (don't delete our own lock)
  const prevWithTimeout = Promise.race([
    prev,
    new Promise<void>((_, reject) =>
      setTimeout(() => {
        reject(new Error('Previous request timed out'))
      }, LOCK_TIMEOUT_MS)
    ),
  ])

  // Listen for client abort: release lock if client disconnects
  const abortHandler = () => {
    release()
    if (sessionLocks.get(sessionId) === current) sessionLocks.delete(sessionId)
  }
  request.signal.addEventListener('abort', abortHandler, { once: true })

  try {
    await prevWithTimeout
  } catch {
    // Previous request timed out — we've already cleared the stale lock, proceed
  }

  let message: string, mentionAll: boolean | undefined, targetAgent: string | undefined, replyToId: string | undefined, regenerate: string | undefined
  try {
    ({ message, mentionAll, targetAgent, replyToId, regenerate } = await request.json())
  } catch {
    return new Response('Invalid JSON body', { status: 400 })
  }
  if (!message || typeof message !== 'string') {
    return new Response('message is required and must be a string', { status: 400 })
  }

  // Fetch session with phase info
  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  if (!session) {
    return new Response('Session not found', { status: 404 })
  }

  const permissionMode = session.permissionMode as 'default' | 'auto'

  // 计算工作目录：优先使用 session.projectDir，否则使用默认的 workspaces 目录
  const workDir = session.projectDir && session.projectDir.trim()
    ? session.projectDir.trim()
    : join(process.cwd(), 'workspaces', sessionId)

  // 处理 /permission 命令
  if (message.trim().startsWith('/permission')) {
    const args = message.trim().split(/\s+/)
    const newMode = args[1]

    if (newMode === 'auto' || newMode === 'default') {
      await prisma.session.update({
        where: { id: sessionId },
        data: { permissionMode: newMode },
      })

      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          const content = newMode === 'auto'
            ? '已切换到自动模式，Agent 操作将自动执行，无需确认。'
            : '已切换到默认模式，Agent 操作需要用户确认。'
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ agentId: 'orchestrator', type: 'text', content })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ agentId: 'orchestrator', type: 'done', content })}\n\n`))
          controller.close()
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      })
    } else {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          const content = '用法：/permission auto 或 /permission default\n\n- auto: 自动模式，减少打扰\n- default: 默认模式，需要确认每次操作'
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ agentId: 'orchestrator', type: 'text', content })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ agentId: 'orchestrator', type: 'done', content })}\n\n`))
          controller.close()
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
  }

  // If regenerate, don't create a new user message
  if (!regenerate) {
    await prisma.message.create({
      data: { role: 'user', rawContent: message, sessionId, replyToId },
    })
  }

  const encoder = new TextEncoder()
  const SSE_TIMEOUT_MS = 5 * 60_000 // 5 minutes global timeout for SSE stream
  const stream = new ReadableStream({
    async start(controller) {
      function sendEvent(data: { agentId: string; type: string; content: string; messageId?: string }) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      }

      // Global SSE timeout: force-close stream after 5 minutes
      const sseTimeout = setTimeout(() => {
        sendEvent({ agentId: 'orchestrator', type: 'error', content: '请求超时（5分钟），请重试' })
        controller.close()
      }, SSE_TIMEOUT_MS)

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

            const { result } = await executeSingleAgent(
              { name: agentName, systemPrompt: agent?.systemPrompt || '', platform: agent?.platform || 'llm', model: agent?.model, baseUrl: agent?.baseUrl, apiKey: agent?.apiKey, workDir, permissionMode },
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
            })
            const context = buildContextFromHistory(history)

            sendEvent({ agentId: agent.name, type: 'status', content: '执行中...' })
            const agentSlug = DIR_SLUGS[agent.name] || agent.name.toLowerCase().replace(/\s+/g, '-')
            const agentWorkDir = join(workDir, agentSlug)
            const { result } = await executeSingleAgent(
              { name: agent.name, systemPrompt: agent.systemPrompt, platform: agent.platform, model: agent.model, baseUrl: agent.baseUrl, apiKey: agent.apiKey, workDir: agentWorkDir, permissionMode },
              message,
              context,
              (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content }),
              sessionId,
              workDir
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
            const agentSlug = DIR_SLUGS[agent.name] || agent.name.toLowerCase().replace(/\s+/g, '-')
            const agentWorkDir = join(workDir, agentSlug)
            const { result } = await executeSingleAgent(
              { name: agent.name, systemPrompt: agent.systemPrompt, platform: agent.platform, model: agent.model, baseUrl: agent.baseUrl, apiKey: agent.apiKey, workDir: agentWorkDir, permissionMode },
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
            await handleOrchestratorDecision(message, sessionId, existingAgents, sendEvent, session.phase)
          }
        }
      } catch (error) {
        sendEvent({ agentId: 'orchestrator', type: 'error', content: String(error) })
      } finally {
        clearTimeout(sseTimeout)
        controller.close()
        release()
        request.signal.removeEventListener('abort', abortHandler)
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
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string; tools: string }>,
  sendEvent: (data: { agentId: string; type: string; content: string }) => void,
  sessionPhase: string
) {
  sendEvent({ agentId: 'orchestrator', type: 'status', content: '思考中...' })

  // 获取对话历史作为上下文
  // Design decision #13: full chat history (no truncation)
  const history = await prisma.message.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  })
  const context = buildContextFromHistory(history)

  // Orchestrator 自主决策（fallback to direct chat if decision fails)
  let decision: { action: string; target?: string | null; targets?: string[] | null; message: string; reason: string }
  try {
    decision = await getOrchestratorDecision(
      message,
      agents.map(a => ({ name: a.name, expertise: a.expertise, platform: a.platform })),
      context
    )
  } catch {
    // Decision engine failed (CLI unavailable, JSON parse error, etc.) — fallback to direct chat
    await handleOrchestratorChat(message, sessionId, sendEvent, agents)
    return
  }

  sendEvent({ agentId: 'orchestrator', type: 'text', content: `[决策] ${decision.reason}` })

  decision = validateDecision(decision, sessionPhase, history)

  // 如果决定 execute 但没有任务，强制走架构师拆解
  if (decision.action === 'execute') {
    const taskCount = await prisma.task.count({ where: { sessionId } })
    if (taskCount === 0) {
      decision = { ...decision, action: 'align_decompose', reason: '尚无任务，需架构师先拆解' }
    }
  }

  switch (decision.action) {
    case 'self':
      // Orchestrator 自己回答（会发送 done）
      await handleOrchestratorChat(message, sessionId, sendEvent, agents)
      break

    case 'delegate':
      // 委派给指定 Agent（done 在 delegateToAgent 内部发送）
      if (decision.target) {
        await delegateToAgent(decision.target, decision.message || message, sessionId, agents, sendEvent)
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
      await transitionToExecution(sessionId, agents, sendEvent)
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
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string; tools: string }>,
  sendEvent: (data: { agentId: string; type: string; content: string }) => void
) {
  const agent = agents.find(a => a.name === agentName)
  if (!agent) {
    sendEvent({ agentId: 'orchestrator', type: 'error', content: `未找到名为 ${agentName} 的 Agent` })
    return
  }

  sendEvent({ agentId: agent.name, type: 'status', content: '执行中...' })

  // 获取对话历史作为上下文
  // Design decision #13: full chat history (no truncation)
  const history = await prisma.message.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  })
  const context = buildContextFromHistory(history)

  // 获取 session 的 workDir
  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  const baseDir = session?.projectDir && session.projectDir.trim()
    ? session.projectDir.trim()
    : join(process.cwd(), 'workspaces', sessionId)
  const agentSlug = DIR_SLUGS[agent.name] || agent.name.toLowerCase().replace(/\s+/g, '-')
  const workDir = join(baseDir, agentSlug)

  const { result } = await executeSingleAgent(
    { name: agent.name, systemPrompt: agent.systemPrompt, platform: agent.platform, model: agent.model, baseUrl: agent.baseUrl, apiKey: agent.apiKey, workDir, permissionMode: session?.permissionMode || 'default' },
    taskMessage,
    context,
    (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content }),
    sessionId,
    baseDir
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
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string; tools: string }>,
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

  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  const baseDir = session?.projectDir && session.projectDir.trim()
    ? session.projectDir.trim()
    : join(process.cwd(), 'workspaces', sessionId)

  const opinions = await runDiscussion(
    topic,
    discussionAgents,
    3,
    (agentName, chunk) => sendEvent({ agentId: agentName, type: chunk.type, content: chunk.content }),
    sessionId,
    baseDir
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

  // 获取 session 的 workDir
  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  const workDir = session?.projectDir && session.projectDir.trim()
    ? session.projectDir.trim()
    : join(process.cwd(), 'workspaces', sessionId)

  const orchConfig = await getOrchestratorAgent()
  const { result } = await executeSingleAgent(
    {
      name: 'Orchestrator', systemPrompt, platform: orchConfig.platform,
      apiKey: orchConfig.apiKey || undefined,
      model: orchConfig.model,
      baseUrl: orchConfig.baseUrl || undefined,
      workDir, permissionMode: session?.permissionMode || 'default',
    },
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
    config = parseJSON(configText, ['name', 'expertise', 'systemPrompt'])
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
      platform: config.platform || 'claude-code',
      capabilities: JSON.stringify(config.capabilities || []),
      accentColor: config.accentColor || '#6366f1',
      isPreset: false,
    },
  })

  await prisma.sessionMember.create({
    data: { sessionId, agentId: agent.id },
  })

  const capabilities = config.capabilities || []
  const promptPreview = config.systemPrompt.length > 100 ? config.systemPrompt.slice(0, 100) + '...' : config.systemPrompt
  const result = `已创建 Agent「${agent.name}」\n专长：${agent.expertise}\n平台：${agent.platform}${capabilities.length ? '\n能力：' + capabilities.join('、') : ''}\n系统提示词：${promptPreview}\n\n如需修改，请在 Agent 面板中编辑。`
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
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string; tools: string }>,
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
  const context = buildContextFromHistory(allMessages)

  // 项目根目录（MCP 协作用，Agent 可读取所有子目录）
  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  const projectRoot = session?.projectDir && session.projectDir.trim()
    ? session.projectDir.trim()
    : join(process.cwd(), 'workspaces', sessionId)

  // Git snapshot before execution (for change detection)
  const gitBefore = getGitSnapshot(projectRoot)

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

    // Mark ready tasks as in_progress
    const failedTaskIds = new Set<string>()
    for (const task of readyTasks) {
      await prisma.task.update({ where: { id: task.id }, data: { status: 'in_progress' } })
      task.status = 'in_progress'
      sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId: task.id, status: 'in_progress' }) })
    }

    // Execute ready tasks in parallel
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
        agents.map(a => ({ name: a.name, systemPrompt: a.systemPrompt, platform: a.platform, model: a.model, baseUrl: a.baseUrl, apiKey: a.apiKey })),
        context,
        (taskId, chunk) => sendEvent({ agentId: taskId, type: chunk.type, content: chunk.content }),
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

    // Mark rejected tasks as failed
    for (const taskId of batchFailedIds) {
      const task = tasks.find(t => t.id === taskId)
      if (task && task.status !== 'failed') {
        await prisma.task.update({ where: { id: taskId }, data: { status: 'failed' } })
        task.status = 'failed'
        sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId, status: 'failed' }) })
      }
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

      // Git-based change detection
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

      // 6.2b: Orchestrator monitoring (all agents — design decision: quality check applies to all)
      const agent = agents.find(a => a.id === task?.assignedAgentId)
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

            // 纠偏重试：将任务回滚为 pending（最多重试 2 次）
            const retryCount = (task as any)._correctionRetryCount || 0
            if (retryCount < 2) {
              await prisma.task.update({ where: { id: taskId }, data: { status: 'pending' } })
              if (task) { task.status = 'pending'; (task as any)._correctionRetryCount = retryCount + 1 }
              sendEvent({ agentId: 'orchestrator', type: 'task_status', content: JSON.stringify({ taskId, status: 'pending', retryCount: retryCount + 1 }) })
              hasProgress = true
            } else {
              sendEvent({ agentId: 'orchestrator', type: 'text', content: `任务 "${task?.description}" 纠偏重试已达上限(2次)，保持完成状态` })
            }
          }
        }
      } catch { /* monitoring failed, continue */ }
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

  if (iteration >= MAX_ITERATIONS) {
    sendEvent({ agentId: 'orchestrator', type: 'error', content: '执行循环超过安全上限，已终止' })
  }

  // Check if all tasks are done
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

// ─── Decision Validation ─────────────────────────────
function validateDecision(
  decision: { action: string; target?: string | null; targets?: string[] | null; message: string; reason: string },
  currentPhase: string,
  history: Array<{ role: string; agentId?: string | null; rawContent: string }>
): { action: string; target?: string | null; targets?: string[] | null; message: string; reason: string } {
  // alignment 中不允许直接 done
  if (currentPhase === 'alignment' && decision.action === 'done') {
    return { ...decision, action: 'align_confirm', reason: '对齐尚未完成，继续确认需求' }
  }

  // execution 中不允许回到 align_*
  if (currentPhase === 'execution' && decision.action.startsWith('align_')) {
    return { ...decision, action: 'execute', reason: '已在执行阶段' }
  }

  // Q&A 循环硬上限：如果已有 Agent 提问且用户已回答，强制执行
  if (decision.action === 'align_qa') {
    const agentQuestions = history.filter(
      m => m.role === 'agent' && m.agentId && m.agentId !== '产品经理' && m.agentId !== '架构师'
    )
    if (agentQuestions.length > 0) {
      // 已有 Agent 提问，检查用户是否已回答
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

// ─── Alignment: PM Confirm ───────────────────────────
async function handlePMConfirm(
  message: string,
  sessionId: string,
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string; tools: string }>,
  sendEvent: (data: { agentId: string; type: string; content: string }) => void
) {
  let currentAgents = agents

  // 如果会话无 Agent，自动生成
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

  // 进入 alignment 阶段
  await prisma.session.update({ where: { id: sessionId }, data: { phase: 'alignment', phaseStep: 'pm_confirm' } })
  sendEvent({ agentId: 'orchestrator', type: 'phase_transition', content: 'alignment' })

  const pmPrompt = PM_CONFIRMATION_PROMPT.replace('{userMessage}', message)
  const pmAgent = currentAgents.find(a => a.name === '产品经理')

  if (pmAgent) {
    // Design decision #12: alignment phases go through adapter layer
    const history = await prisma.message.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } })
    const context = buildContextFromHistory(history)
    const session = await prisma.session.findUnique({ where: { id: sessionId } })
    const baseDir = session?.projectDir && session.projectDir.trim()
      ? session.projectDir.trim()
      : join(process.cwd(), 'workspaces', sessionId)
    const pmSlug = DIR_SLUGS[pmAgent.name] || pmAgent.name.toLowerCase().replace(/\s+/g, '-')
    const workDir = join(baseDir, pmSlug)

    try {
      const { result } = await executeSingleAgent(
        { name: pmAgent.name, systemPrompt: pmAgent.systemPrompt, platform: pmAgent.platform, model: pmAgent.model, baseUrl: pmAgent.baseUrl, apiKey: pmAgent.apiKey, workDir, permissionMode: session?.permissionMode || 'default', id: pmAgent.id, tools: pmAgent.tools },
        pmPrompt,
        context,
        (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content }),
        sessionId,
        baseDir
      )
      await prisma.message.create({ data: { role: 'agent', rawContent: result, sessionId, agentId: '产品经理' } })
      sendEvent({ agentId: '产品经理', type: 'done', content: result })
      sendEvent({ agentId: 'orchestrator', type: 'awaiting_user_input', content: 'pm_confirm' })
    } catch {
      sendEvent({ agentId: 'orchestrator', type: 'error', content: '需求确认失败，请重试' })
    }
  } else {
    // Fallback: no PM agent, use Orchestrator's LLM API
    sendEvent({ agentId: '产品经理', type: 'status', content: '正在确认需求...' })
    try {
      const result = await callLLMForAnalysis(pmPrompt)
      await prisma.message.create({ data: { role: 'agent', rawContent: result, sessionId, agentId: '产品经理' } })
      sendEvent({ agentId: '产品经理', type: 'done', content: result })
      sendEvent({ agentId: 'orchestrator', type: 'awaiting_user_input', content: 'pm_confirm' })
    } catch {
      sendEvent({ agentId: 'orchestrator', type: 'error', content: '需求确认失败，请重试' })
    }
  }
}

// ─── Alignment: Architect Plan ───────────────────────
async function handleArchitectPlan(
  message: string,
  sessionId: string,
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string; tools: string }>,
  sendEvent: (data: { agentId: string; type: string; content: string }) => void
) {
  await prisma.session.update({ where: { id: sessionId }, data: { phase: 'alignment', phaseStep: 'architect_plan' } })
  sendEvent({ agentId: 'orchestrator', type: 'phase_transition', content: 'alignment' })

  const history = await prisma.message.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } })
  const originalRequest = history.find(m => m.role === 'user')?.rawContent || message
  const context = buildContextFromHistory(history)

  const archAgent = agents.find(a => a.name === '架构师')
  let scheduledTasks: ScheduledTask[]

  if (archAgent) {
    // Design decision #12: architect phase goes through adapter layer
    const session = await prisma.session.findUnique({ where: { id: sessionId } })
    const baseDir = session?.projectDir && session.projectDir.trim()
      ? session.projectDir.trim()
      : join(process.cwd(), 'workspaces', sessionId)
    const archSlug = DIR_SLUGS[archAgent.name] || archAgent.name.toLowerCase().replace(/\s+/g, '-')
    const workDir = join(baseDir, archSlug)
    const agentList = agents.map(a => `${a.name}（${a.expertise}）`).join('、')
    const archPrompt = `任务描述：${originalRequest}\n可用角色：${agentList}`

    sendEvent({ agentId: archAgent.name, type: 'status', content: '正在拆解任务...' })
    try {
      const { result } = await executeSingleAgent(
        { name: archAgent.name, systemPrompt: archAgent.systemPrompt, platform: archAgent.platform, model: archAgent.model, baseUrl: archAgent.baseUrl, apiKey: archAgent.apiKey, workDir, permissionMode: session?.permissionMode || 'default', id: archAgent.id, tools: archAgent.tools },
        archPrompt,
        context,
        (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content }),
        sessionId,
        baseDir
      )

      // Parse structured task output from architect's response
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
        // JSON parse from agent output failed, fallback to decomposeTasks
        scheduledTasks = await decomposeTasks(originalRequest, agents.map(a => ({ name: a.name, expertise: a.expertise })))
      }
    } catch {
      // executeSingleAgent failed entirely, fallback to decomposeTasks
      scheduledTasks = await decomposeTasks(originalRequest, agents.map(a => ({ name: a.name, expertise: a.expertise })))
    }
  } else {
    // Fallback: no architect agent, use Orchestrator's internal LLM
    sendEvent({ agentId: '架构师', type: 'status', content: '正在拆解任务...' })
    scheduledTasks = await decomposeTasks(originalRequest, agents.map(a => ({ name: a.name, expertise: a.expertise })))
  }

  if (scheduledTasks.length === 0) {
    sendEvent({ agentId: '架构师', type: 'text', content: '未能生成有效任务方案，请重新描述需求或手动指定任务' })
    return
  }

  // 持久化 Task 记录（使用 decomposeTasks 生成的 UUID 作为 id）
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

// ─── Alignment: Agent Q&A ────────────────────────────
async function handleAgentQA(
  message: string,
  sessionId: string,
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string; tools: string }>,
  sendEvent: (data: { agentId: string; type: string; content: string }) => void
) {
  await prisma.session.update({ where: { id: sessionId }, data: { phase: 'alignment', phaseStep: 'agent_qa' } })

  const history = await prisma.message.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } })
  const originalRequest = history.find(m => m.role === 'user')?.rawContent || ''
  const architectPlan = history.find(m => m.agentId === '架构师')?.rawContent || ''

  sendEvent({ agentId: 'orchestrator', type: 'status', content: '多个 Agent 正在整理问题...' })

  // Design decision #12: QA phase goes through adapter layer
  const context = buildContextFromHistory(history)
  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  const workDir = session?.projectDir && session.projectDir.trim()
    ? session.projectDir.trim()
    : join(process.cwd(), 'workspaces', sessionId)

  // 并行调用各 Agent 检查疑问
  const results = await Promise.allSettled(
    agents.map(async (agent) => {
      const prompt = buildAgentQuestionPrompt(agent.name, agent.expertise, originalRequest, architectPlan)
      const agentSlug = DIR_SLUGS[agent.name] || agent.name.toLowerCase().replace(/\s+/g, '-')
      const agentWorkDir = join(workDir, agentSlug)
      try {
        const { result } = await executeSingleAgent(
          { name: agent.name, systemPrompt: agent.systemPrompt, platform: agent.platform, model: agent.model, baseUrl: agent.baseUrl, apiKey: agent.apiKey, workDir: agentWorkDir, permissionMode: session?.permissionMode || 'default', id: agent.id, tools: agent.tools },
          prompt,
          context,
          (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content }),
          sessionId,
          workDir
        )
        return { agent, response: result }
      } catch {
        // Fallback to Orchestrator's LLM for this agent
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

// ─── Transition to Execution ─────────────────────────
async function transitionToExecution(
  sessionId: string,
  agents: Array<{ id: string; name: string; systemPrompt: string; platform: string; expertise: string; model: string; baseUrl: string; apiKey: string; tools: string }>,
  sendEvent: (data: { agentId: string; type: string; content: string }) => void
) {
  await prisma.session.update({ where: { id: sessionId }, data: { phase: 'execution', phaseStep: '' } })
  sendEvent({ agentId: 'orchestrator', type: 'phase_transition', content: 'execution' })
  sendEvent({ agentId: 'orchestrator', type: 'awaiting_user_input', content: '' })

  await handleExecution('', sessionId, agents, sendEvent)
}

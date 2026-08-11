import { prisma } from '@/lib/db'
import { getOrchestratorDecision, executeSingleAgent, getOrchestratorAgent } from '@/lib/orchestrator'
import { buildContextFromHistory } from './context-builder'
import { reviewResult, delegateToAgent, runMultiAgentDiscussion } from './review'
import { handlePMConfirm, handleArchitectPlan, handleAgentQA, transitionToExecution, isCodeTask } from './alignment'
import type { SendEvent } from './review'
import type { TaskAttachment, AgentConfig } from '@/lib/adapter/types'
import { TimeoutError } from '@/lib/orchestrator/timeout'
import { stateFromSession, applyTransition, canonicalCorrect, transitionPhase, idleExecuteGate } from '@/lib/orchestrator/state-machine'

/**
 * safe-parse declaredFiles：架构师 LLM 拆解可能输出畸形 declared_files（字符串/数字等），
 * 裸 JSON.parse 得到非数组会在 isCodeTask 的 .some() 处抛 TypeError 击穿整个决策点。
 * 畸形 → 降级为 []（非代码），fail-safe 不击穿（审查抓出）。
 */
export function parseDeclaredFiles(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * 判断消息是否是"创建 Agent"意图（chat route 的路由启发式）。
 *
 * 两个条件必须同时满足：
 * 1. 创建/新建类动词
 * 2. agent 类关键词——"agent"必须是独立词（\b 词边界），否则 "AgentHub"、
 *    "helloAgent" 等文件名/产品名会误命中；中文"智能体/助手"直接字面匹配
 *    （JS \b 是 ASCII 词边界，对中文无效，不能包在 \b 里）
 */
export function isCreateAgentIntent(message: string): boolean {
  if (!message) return false
  // 保留 create.*agent 兼容纯英文"create an agent"（旧行为）；\b 词边界兜住 "create AgentHub" 误判
  const hasCreateVerb = /创建|新建|添加|帮我建|create.*agent|建一?个/i.test(message)
  const hasAgentKeyword = /\bagent\b/i.test(message) || /智能体|助手/.test(message)
  return hasCreateVerb && hasAgentKeyword
}

export async function handleOrchestratorDecision(
  message: string,
  sessionId: string,
  agents: AgentConfig[],
  sendEvent: SendEvent,
  sessionPhase: { phase: string; phaseStep: string },
  attachments?: TaskAttachment[],
  workDir?: string,
  permissionMode?: string,
  globalDeadline?: number
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
      workDir,
      permissionMode
    )
    decision = result.decision
    orchSessionId = result.sessionId
  } catch (err) {
    if (err instanceof TimeoutError) {
      console.error('[TIMEOUT] getOrchestratorDecision')
      sendEvent({ agentId: 'orchestrator', type: 'error', content: 'Orchestrator 决策超时，请重试' })
      return
    }
    await handleOrchestratorChat(message, sessionId, sendEvent, agents)
    return
  }

  const state = stateFromSession(sessionPhase.phase, sessionPhase.phaseStep)

  // Hybrid 规范化纠正（3 条）：命中 -> redirect 到合法 action（不静默，附 reason）
  const correction = canonicalCorrect(state, decision.action, history)
  if (correction) {
    decision = { ...decision, action: correction.redirect, reason: `${decision.reason}（规范化纠正 -> ${correction.redirect}）` }
  }

  // P2 idle→execute 确定性闸门（决定 3）：idle 态跳步执行需过 idleExecuteGate（有任务且全非代码），
  // 否则回对齐拆解——跳步不是"LLM 说简单就简单"。非 idle 态保留 0-task 守卫（补拆，T5）。
  if (decision.action === 'execute') {
    const tasks = await prisma.task.findMany({ where: { sessionId }, select: { description: true, declaredFiles: true } })
    const hasCodeTask = tasks.some(t => isCodeTask({ description: t.description, declaredFiles: parseDeclaredFiles(t.declaredFiles) }))
    if (state === 'idle' ? !idleExecuteGate(tasks.length, hasCodeTask) : tasks.length === 0) {
      decision = { ...decision, action: 'align_decompose', reason: state === 'idle' ? '确定性闸门：需先对齐拆解' : '尚无任务，需架构师先拆解' }
    }
  }

  // done 业务守卫（§5.1: exec→done 需 allDone，allDone = 全部 completed|blocked）：
  // exec 态还有未完成任务（含 failed）-> 不关闭会话，redirect execute 继续执行/提示收尾
  if (decision.action === 'done' && state === 'exec') {
    const unfinished = await prisma.task.count({ where: { sessionId, status: { notIn: ['completed', 'blocked'] } } })
    if (unfinished > 0) {
      decision = { ...decision, action: 'execute', reason: `还有 ${unfinished} 个未完成任务，继续执行` }
    } else {
      // §5.3: 有 verify 任务但未 completed（blocked 计入 allDone，会漏）-> 不关闭会话。
      // verify 由 alignment.ts 拆解代码任务时自动追加，blocked 意味着验证被依赖失败波及，
      // 放行 done 会造成"完成但未验证"。
      const verify = await prisma.task.findFirst({ where: { sessionId, id: { startsWith: 'verify-' } }, select: { status: true } })
      if (verify && verify.status !== 'completed') {
        decision = { ...decision, action: 'execute', reason: `验证任务未完成（${verify.status}），继续执行` }
      }
    }
  }

  // If delegate is chosen but there are pending tasks, append a note but don't override the action
  if (decision.action === 'delegate') {
    const pendingTasks = await prisma.task.count({ where: { sessionId, status: 'pending' } })
    if (pendingTasks > 0) {
      decision = { ...decision, reason: `${decision.reason}（另有${pendingTasks}个待执行任务）` }
    }
  }

  // 转移合法性校验（纠正 + 业务守卫之后）：真非法 -> escalate（不静默，学 CrewAI 反面）
  const transition = applyTransition(state, decision.action)
  if (!transition.ok) {
    sendEvent({ agentId: 'orchestrator', type: 'text', content: `[需人工介入] 当前状态「${state}」下不允许「${decision.action}」。${transition.reason}。请调整指令或手动引导下一步。` })
    sendEvent({ agentId: 'orchestrator', type: 'awaiting_user_input', content: 'escalate' })
    // JSON.stringify 转义 \n，防 LLM 注入的 action/reason 伪造日志行（CRLF 日志注入）
    console.warn('[state-machine] escalate:', JSON.stringify(transition.reason), '| LLM 提议', JSON.stringify(decision.action))
    return
  }

  sendEvent({ agentId: 'orchestrator', type: 'text', content: `[决策] ${decision.reason}` })

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
      // P2 待办④: 0 任务/超时 handleArchitectPlan 返回 false(已发 error+replan),显式中止,与 transitionToExecution 契约一致
      if (!(await handleArchitectPlan(message, sessionId, agents, sendEvent))) return
      break
    case 'align_qa':
      await handleAgentQA(message, sessionId, agents, sendEvent, globalDeadline)
      break
    case 'execute':
      await transitionToExecution(sessionId, agents, sendEvent, message, orchSessionId, globalDeadline)
      break
    case 'verify':
      // ISSUE-008 已实现：执行层强制 verify 靠 alignment.ts 拆解代码任务时自动追加 verify 任务。
      // 此 case 仅兜底 LLM 主动提议 verify 时路由不静默丢失。
      // 有目标 Agent（如测试工程师）→ 委派验证；否则 Orchestrator 自己验证（走 CLI 真实执行）
      if (decision.target) {
        await delegateToAgent(decision.target, decision.message || message, sessionId, agents, sendEvent, attachments, orchSessionId)
      } else {
        await handleOrchestratorChat(decision.message || message, sessionId, sendEvent, agents, orchSessionId)
      }
      break
    case 'done':
      await transitionPhase(sessionId, 'done')
      sendEvent({ agentId: 'orchestrator', type: 'text', content: decision.message || '任务已完成' })
      sendEvent({ agentId: 'orchestrator', type: 'done', content: decision.message || '任务已完成' })
      break
  }
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
- 回复简洁，不要用 emoji，控制在 200 字以内

重要：直接回复自然语言文本，不要返回 JSON 格式。不要包含 action、target、reason 等字段。`

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

/**
 * @所有人 讨论：调用 runMultiAgentDiscussion（含质量审查）
 * 从 chat/route.ts 提取，消除重复逻辑。
 */
export async function handleMentionAllDiscussion(
  message: string,
  sessionId: string,
  agents: AgentConfig[],
  sendEvent: SendEvent,
  workDir: string
) {
  sendEvent({ agentId: 'orchestrator', type: 'status', content: '开始多轮讨论...' })
  await runMultiAgentDiscussion(
    agents.map(a => a.name),
    message,
    sessionId,
    agents,
    sendEvent
  )
}

/**
 * 直接与指定 Agent 对话（@提及 或 私聊）
 * 从 chat/route.ts 提取，消除 targetAgent / private 两条路径的重复代码。
 */
export async function handleDirectAgentChat(
  agent: { id: string; name: string; systemPrompt: string; platform: string; model: string; baseUrl: string; apiKey: string },
  message: string,
  sessionId: string,
  sendEvent: SendEvent,
  workDir: string,
  permissionMode: string,
  attachments?: TaskAttachment[]
) {
  // 从 SessionMember 读取 cliSessionId 用于会话恢复
  const member = await prisma.sessionMember.findUnique({
    where: { sessionId_agentId: { sessionId, agentId: agent.id } },
  })

  sendEvent({ agentId: agent.name, type: 'status', content: '执行中...' })
  const { result, sessionId: cliSessionId } = await executeSingleAgent(
    { id: agent.id, name: agent.name, systemPrompt: agent.systemPrompt, platform: agent.platform, model: agent.model || undefined, baseUrl: agent.baseUrl, apiKey: agent.apiKey, workDir, permissionMode, sessionId: member?.cliSessionId || undefined },
    message,
    '',
    (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content, data: chunk.data }),
    sessionId,
    workDir,
    attachments
  )

  // 保存 cliSessionId 到 SessionMember
  if (cliSessionId) {
    await prisma.sessionMember.update({
      where: { sessionId_agentId: { sessionId, agentId: agent.id } },
      data: { cliSessionId },
    })
  }

  await prisma.message.create({ data: { role: 'agent', rawContent: result, sessionId, agentId: agent.name } })
  const { quality } = await reviewResult(result, message, sessionId, sendEvent)
  sendEvent({ agentId: agent.name, type: 'done', content: result, data: { quality } })
}

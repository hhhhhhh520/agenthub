import { prisma } from '@/lib/db'
import { executeSingleAgent, callLLMForAnalysis, analyzeScene, generateRoles, decomposeTasks, parseJSON, formatArchitectPlan } from '@/lib/orchestrator'
import { TimeoutError } from '@/lib/orchestrator/timeout'
import { PM_CONFIRMATION_PROMPT, buildAgentQuestionPrompt } from '@/lib/orchestrator/prompts'
import { topologicalSort, type ScheduledTask } from '@/lib/orchestrator/scheduler'
import { handleExecution } from './execution'
import type { SendEvent } from './review'
import type { AgentConfig } from '@/lib/adapter/types'
import { transitionPhase } from '@/lib/orchestrator/state-machine'

/** ISSUE-008: 代码文件后缀,用于识别代码任务(自动触发验证) */
const CODE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|java|go|rs|rb|c|cc|cpp|h|hpp|cs|php|sh|html|css|scss|less|vue|svelte|sql|kt|swift|lua|pl|dart|scala)$/i

/** 判断任务是否为代码任务:声明文件含代码后缀,或任务描述提到代码文件 */
export function isCodeTask(task: { description: string; declaredFiles: string[] }): boolean {
  if (task.declaredFiles.some(f => CODE_EXT_RE.test(f))) return true
  return CODE_EXT_RE.test(task.description)
}

/** 构造验证任务描述:列出待验证代码任务及产出文件(依赖结果经 <dependency> 块注入) */
export function buildVerifyDescription(codeTasks: Array<{ description: string; declaredFiles: string[] }>): string {
  const lines = codeTasks.map(t =>
    `- ${t.description}${t.declaredFiles.length > 0 ? `（产出文件：${t.declaredFiles.join('、')}）` : ''}`
  )
  return `[系统验证任务] 验证以下代码任务的产出物是否真实可用。请逐项实际检查产出文件（是否存在、语法是否正确、能否运行），不要修改任何文件，只检查并报告：\n${lines.join('\n')}\n逐项给出结论；全部通过回复"验证通过"，有问题的项列明具体问题。`
}

/**
 * PM 需求确认。仅被 LLM 决策路径（chat-router align_confirm）调用。
 * P4 T1: opts.recordTrace 透传给内部 transitionPhase——决策点已记 align_confirm,默认抑制(false);
 * 决策点 append 失败时 chat-router 传 true 兜底补记,防丢审计。
 */
export async function handlePMConfirm(
  message: string,
  sessionId: string,
  agents: AgentConfig[],
  sendEvent: SendEvent,
  opts?: { recordTrace?: boolean }
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

  // P4 T1: recordTrace 默认 false(handlePMConfirm 仅 LLM 决策路径调用,决策点已记 align_confirm);
  // 决策点 append 失败时 chat-router 传 true 兜底补记
  await transitionPhase(sessionId, 'align_confirm', { recordTrace: opts?.recordTrace ?? false })
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

/**
 * 架构师拆解任务。返回 true=成功(任务全建 + phase 推进), false=0 任务或拆解超时(未写 phase,调用方应中止)。
 * P2 待办④: 0 任务时不把 phase 空转 align_arch(旧代码顶部先 transitionPhase,0 任务也停在对齐态)——
 * phase 转移到拆解成功且任务全建之后,0 任务持久化 [REPLAN] 标记 + 等用户重述;拆解超时同样中止。
 * P4 T1: opts.recordTrace 透传给内部 transitionPhase——LLM 决策路径(chat-router)传 false(决策点已记)；
 * 代码驱动路径(transitionToExecution 0-task 补拆)省略即 true(默认补记)。
 */
export async function handleArchitectPlan(
  message: string,
  sessionId: string,
  agents: AgentConfig[],
  sendEvent: SendEvent,
  opts?: { recordTrace?: boolean }
): Promise<boolean> {
  const history = await prisma.message.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } })
  // P2 待办④: 上一轮拆解 0 任务([REPLAN] 标记)时用最新 user 重述,否则用首条需求——
  // 否则重述只进 orchestrator 上下文,架构师拆的仍是冻结旧需求,无限重述零进展(审查抓出)
  const lastOrch = [...history].reverse().find(m => m.role === 'orchestrator')
  const isReplan = lastOrch?.role === 'orchestrator' && String(lastOrch.rawContent).startsWith('[REPLAN]')
  const originalRequest = isReplan
    ? [...history].reverse().find(m => m.role === 'user')?.rawContent || message
    : history.find(m => m.role === 'user')?.rawContent || message

  const archAgent = agents.find(a => a.name === '架构师')
  let scheduledTasks: ScheduledTask[]

  if (archAgent) {
    const session = await prisma.session.findUnique({ where: { id: sessionId } })
    const workDir = session?.projectDir && session.projectDir.trim()
      ? session.projectDir.trim()
      : process.cwd()
    const agentList = agents.map(a => `${a.name}（${a.expertise}）`).join('、')
    // ISSUE-011 F4: 主路径(有架构师 Agent)也注入技术栈一致性约束——
    // TASK_DECOMPOSITION_PROMPT 只在兜底/无架构师路径生效,主路径用架构师自己的
    // systemPrompt,读不到该约束。此处显式注入确保拆解产出与 declared_files 技术栈一致。
    const archPrompt = `任务描述：${originalRequest}\n可用角色：${agentList}\n\n技术栈一致性约束：技术方案(techStack)必须与各任务 declared_files 的文件后缀一致——声明 Node.js+TypeScript 则用 .ts/.tsx，不得写成其他技术栈（如 Python）。设计文档与实现不一致会让后续 Agent 困惑。`

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
        const parsed = parseJSON<{ tasks: Array<{ id: number; description: string; assignedAgent: string; dependencies: number[]; declared_files?: string[]; output_schema?: string[] }> }>(result, ['tasks'])
        const idMap = new Map<number, string>()
        parsed.tasks.forEach(t => idMap.set(t.id, crypto.randomUUID()))
        scheduledTasks = topologicalSort(parsed.tasks.map(t => ({
          id: idMap.get(t.id)!,
          description: t.description,
          assignedAgent: t.assignedAgent,
          dependencies: t.dependencies.map(d => idMap.get(d)!).filter(Boolean),
          declaredFiles: t.declared_files || [],
          outputSchema: t.output_schema ? JSON.stringify(t.output_schema) : undefined,
          batch: 0,
        })))
      } catch {
        sendEvent({ agentId: archAgent.name, type: 'status', content: '任务拆解格式异常，正在重新生成...' })
        scheduledTasks = await decomposeTasks(originalRequest, agents.map(a => ({ name: a.name, expertise: a.expertise })))
      }
    } catch (err) {
      if (err instanceof TimeoutError) {
        console.error('[TIMEOUT] handleArchitectPlan')
        sendEvent({ agentId: 'orchestrator', type: 'error', content: '架构师任务拆解超时，请重试' })
        sendEvent({ agentId: 'orchestrator', type: 'awaiting_user_input', content: 'replan' })
        return false
      }
      scheduledTasks = await decomposeTasks(originalRequest, agents.map(a => ({ name: a.name, expertise: a.expertise })))
    }
  } else {
    sendEvent({ agentId: '架构师', type: 'status', content: '正在拆解任务...' })
    scheduledTasks = await decomposeTasks(originalRequest, agents.map(a => ({ name: a.name, expertise: a.expertise })))
  }

  if (scheduledTasks.length === 0) {
    // P2 待办④: 0 任务不把 phase 空转 align_arch——持久化 [REPLAN] 标记 + 发 error + 等用户重述,
    // 返回 false 让调用方(transitionToExecution)中止。标记供下次拆解用最新重述(审查抓出重述不生效)
    await prisma.message.create({ data: { role: 'orchestrator', rawContent: '[REPLAN]未能生成有效任务方案，请重新描述需求或手动指定任务', sessionId } })
    sendEvent({ agentId: 'orchestrator', type: 'error', content: '未能生成有效任务方案，请重新描述需求或手动指定任务' })
    sendEvent({ agentId: 'orchestrator', type: 'awaiting_user_input', content: 'replan' })
    return false
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
        outputSchema: task.outputSchema ?? null,
      },
    })
  }

  // ISSUE-008: 执行层强制 verify —— LLM 倾向直接 done 而非 verify,仅靠 prompt 无法改变决策。
  // 拆解出代码任务时自动追加验证任务:依赖全部代码任务,经既有依赖就绪门控在代码完成后自动执行
  // (handleExecution readyTasks 要求 deps 全 completed,verify 自然排在代码任务之后)。
  // verify- 前缀 id 用于识别,多轮对齐时避免重复创建;redo 路径不新建——若 verify 因依赖
  // 失败被 blocked,execution.ts 的"blocked 依赖补齐自动复活"机制会在 redo 后重新执行它。
  const codeTasks = scheduledTasks.filter(t => isCodeTask(t) && !t.id.startsWith('verify-'))
  // P6 T7: verify 维度实验开关——EXPERIMENT_VERIFY=off 只关自动创建(实验 harness),生产默认未设零影响。
  // done 守卫(chat-router.ts:127)天然正交:OFF 下已跳过,ON+no-verify 无 verify 可查。
  if (codeTasks.length > 0 && process.env.EXPERIMENT_VERIFY !== 'off') {
    const existingVerify = await prisma.task.findFirst({ where: { sessionId, id: { startsWith: 'verify-' } } })
    if (!existingVerify) {
      const verifyAgent = agents.find(a => a.name.includes('测试'))
      await prisma.task.create({
        data: {
          id: `verify-${crypto.randomUUID()}`,
          description: buildVerifyDescription(codeTasks),
          status: 'pending',
          // 优先测试工程师;无则 null,executeTaskBatch 的 findBestAgent 会按"验证/测试"关键词匹配,最终兜底到其他 agent
          assignedAgentId: verifyAgent?.id ?? null,
          sessionId,
          dependencies: JSON.stringify(codeTasks.map(t => t.id)),
          // 验证任务不产生文件,跳过文件校验(不误报越界);代码任务结果经 <dependency> 块注入
          declaredFiles: '[]',
        },
      })
      sendEvent({ agentId: 'orchestrator', type: 'text', content: `已自动创建验证任务：将验证 ${codeTasks.length} 个代码任务的产出物` })
    }
  }

  // P2 待办④: phase 在"任务全建"之后推进(0 任务/拆解失败/任务创建中途抛错都不留 align_arch 空转;
  // 声明审查 Q2: 先写 phase 后建任务会在 task.create 中途抛错时留"phase 已推进但任务不全"窗口)
  // P4 T1: recordTrace 默认 true(代码驱动补拆补记),LLM 决策路径由 chat-router 传 false
  await transitionPhase(sessionId, 'align_decompose', { recordTrace: opts?.recordTrace ?? true })
  sendEvent({ agentId: 'orchestrator', type: 'phase_transition', content: 'alignment' })

  const planSummary = formatArchitectPlan(scheduledTasks, agents)
  await prisma.message.create({ data: { role: 'agent', rawContent: planSummary, sessionId, agentId: '架构师' } })
  sendEvent({ agentId: '架构师', type: 'done', content: planSummary })
  sendEvent({ agentId: 'orchestrator', type: 'awaiting_user_input', content: 'architect_plan' })
  return true
}

/**
 * 对齐 Q&A（多 Agent 整理问题）。align_qa 入口仅被 LLM 决策路径（chat-router align_qa）调用。
 * P4 T1: opts.recordTrace 透传给内部 transitionPhase——决策点已记 align_qa,默认抑制(false);
 * 决策点 append 失败时 chat-router 传 true 兜底补记。内部"无疑问直发 exec"恒为代码驱动(recordExecuteTrace:true)。
 */
export async function handleAgentQA(
  message: string,
  sessionId: string,
  agents: AgentConfig[],
  sendEvent: SendEvent,
  globalDeadline?: number,
  opts?: { recordTrace?: boolean }
) {
  // P4 T1: recordTrace 默认 false(handleAgentQA 入口仅 LLM 决策路径,决策点已记 align_qa);
  // 决策点 append 失败时 chat-router 传 true 兜底补记
  await transitionPhase(sessionId, 'align_qa', { recordTrace: opts?.recordTrace ?? false })

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
      } catch (err) {
        if (err instanceof TimeoutError) {
          console.error('[TIMEOUT] handleAgentQA', agent.name)
          return { agent, response: '[问答超时]' }
        }
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
    // P4 T1: 无疑问直发 exec = 代码驱动转移(QA 直发 exec),recordExecuteTrace:true 补记
    await transitionToExecution(sessionId, agents, sendEvent, undefined, undefined, globalDeadline, { recordExecuteTrace: true })
  }
}

export async function transitionToExecution(
  sessionId: string,
  agents: AgentConfig[],
  sendEvent: SendEvent,
  userMessage?: string,
  orchSessionId?: string,
  globalDeadline?: number,
  opts?: { recordExecuteTrace?: boolean }
) {
  // 兜底：Task 为空时先自动补拆，再进入 execution。
  // 顺序关键：不能先写 exec 再补拆（会写回 align_arch，执行期间 phase 停在对齐态、
  // allDone 时 align_arch+done 在转移表非法、fail-closed 拒绝写 done）。先补拆到 align_arch，再 execute -> exec 是合法转移。
  const existingTasks = await prisma.task.findMany({ where: { sessionId } })
  if (existingTasks.length === 0) {
    sendEvent({ agentId: 'orchestrator', type: 'status', content: '任务列表为空，正在自动拆解...' })
    // P2 待办④: 补拆 0 任务(handleArchitectPlan 返回 false)则中止,不进 execute 空跑 handleExecution
    // P4 T1: 0-task 补拆 = 代码驱动,handleArchitectPlan 省略 opts -> recordTrace 默认 true 补记。
    // 审查锁定(声明vs实现 Finding 4): 此分支只从代码驱动路径触发——chat-router execute case 有 0-task
    // 守卫(idle 闸门/非 idle 都要求 tasks>0),LLM execute 路径不可能进这里;若未来取消守卫,会出现
    // "决策点已记 execute + 补拆补记 align_decompose"的转移分歧 + 缺 align_arch→exec 边,禁止打破此前提。
    const ok = await handleArchitectPlan(userMessage || '', sessionId, agents, sendEvent)
    if (!ok) return
  }

  // P4 T1: recordTrace 默认 true(代码驱动补记);LLM 决策路径(chat-router 'execute')显式传 false 防双记
  await transitionPhase(sessionId, 'execute', { recordTrace: opts?.recordExecuteTrace ?? true })
  sendEvent({ agentId: 'orchestrator', type: 'phase_transition', content: 'execution' })

  sendEvent({ agentId: 'orchestrator', type: 'awaiting_user_input', content: '' })
  await handleExecution(userMessage || '', sessionId, agents, sendEvent, orchSessionId, globalDeadline)
}

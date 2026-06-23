import { join } from 'path'
import { prisma } from '@/lib/db'
import { getOrchestratorConfig, ensureOrchestratorAgent } from '@/lib/app-config'
import { createAdapter, type StreamChunk, type AdapterConfig } from '../adapter'
import { processRegistry } from '../adapter/process-registry'
import { withTimeout, TIMEOUT, TimeoutError } from './timeout'
import type { TaskAttachment } from '../adapter/types'
import { buildMCPConfig } from '../mcp-config'
import { SCENE_ANALYSIS_PROMPT, ROLE_GENERATION_PROMPT, TASK_DECOMPOSITION_PROMPT, buildDiscussionPrompt, ORCHESTRATOR_DECISION_PROMPT } from './prompts'
import { topologicalSort, type ScheduledTask } from './scheduler'

// 构建 ProcessRegistry key（与 adapter 内部 getRegistryKey 保持一致）
// 注意：workDir 必须和 adapter.connect() 时的值一致，否则 gracefulKillEntry 查不到进程
function buildRegistryKey(platform: string, chatSessionId?: string, agentId?: string, workDir?: string): string {
  const sessionPart = chatSessionId || 'default'
  const agentPart = agentId || 'default'
  // ClaudeCodeAdapter: config.workDir || process.cwd()
  // OpenCodeAdapter: config.workDir || join(process.cwd(), 'workspaces', `opencode-${Date.now()}`)
  // OpenCode 的 key 含时间戳，超时时无法重建，但 ndjson 格式会自动清理
  const dir = workDir || process.cwd()
  return platform === 'opencode'
    ? `opencode:${sessionPart}:${agentPart}:${dir}`
    : `${sessionPart}:${agentPart}:${dir}`
}

// 隐性行为准则：自动注入所有 Agent 的 System Prompt
const AGENT_BEHAVIOR_RULES = `<role>你是 AgentHub 平台上的独立 Agent，与其他 Agent 协作完成用户任务。</role>

<behavior>
  <interaction>
    <rule>等待用户明确任务后再行动，不要假设自己在某个项目中</rule>
    <rule>未被要求时不要主动读取代码文件或项目结构</rule>
    <rule>初次对话时简洁介绍自身能力，等待用户指令</rule>
    <rule>不确定需求时先提问，不要猜测</rule>
    <rule>被阻塞或无法完成时明确告知原因，不要编造结果</rule>
  </interaction>

  <collaboration>
    <rule>任务完成后必须汇报：完成了什么、产出在哪里、验证方式、遗留问题</rule>
    <rule>长任务在关键里程碑汇报进度（如：完成一个子任务、遇到重要发现）</rule>
    <rule>遇到阻塞立即上报，不要等待超时</rule>
    <rule>依赖其他 Agent 的产出时，明确说明需要什么、格式要求</rule>
    <rule>发现其他 Agent 的产出有问题时，指出问题但不要自行修改</rule>
    <rule>代码修改后运行相关测试验证</rule>
  </collaboration>

  <safety>
    <rule>不要越界执行其他角色的职责</rule>
    <rule>不要执行破坏性操作（删除文件、清空数据库等）未经用户确认</rule>
    <rule>修改文件前确认可回滚</rule>
  </safety>
</behavior>

<completion_report>
任务完成时，必须包含以下信息：
1. 完成了什么（一句话概括）
2. 产出物位置（文件路径、分支名等）
3. 验证方式（测试命令、检查步骤）
4. 遗留问题（如有）
5. 对其他 Agent 的影响（如有）

示例：
"已完成用户登录模块开发。
产出：src/auth/login.ts, src/auth/middleware.ts
验证：npm run test -- --grep 'auth'
遗留：OAuth 集成待第三方提供 client_id
影响：后端 API 已就绪，前端可开始对接"
</completion_report>

<milestone_report>
长任务在关键节点汇报进度，示例：
"✅ 已完成数据库 Schema 设计
⏳ 下一步：编写 API 接口"
</milestone_report>`

// Update agent status per-session (not global Agent.status)
async function updateAgentSessionStatus(sessionId: string | undefined, agentId: string | undefined, agentName: string, status: string) {
  if (!sessionId) return
  try {
    if (agentId) {
      await prisma.sessionMember.updateMany({ where: { sessionId, agentId }, data: { status } })
    } else {
      // Fallback: find by agent name
      const agent = await prisma.agent.findFirst({ where: { name: agentName }, select: { id: true } })
      if (agent) {
        await prisma.sessionMember.updateMany({ where: { sessionId, agentId: agent.id }, data: { status } })
      }
    }
  } catch {}
}

export interface OrchestratorDecision {
  action: 'self' | 'delegate' | 'discuss' | 'align_confirm' | 'align_decompose' | 'align_qa' | 'execute' | 'done'
  target?: string | null
  targets?: string[] | null
  message: string
  reason: string
}

const EMPTY_RESPONSE = '[Agent 未返回有效内容]'

/**
 * 获取 Orchestrator Agent 配置
 * 优先从 Agent 表读取（isOrchestrator=true），不存在时从 AppConfig 迁移
 * 如果 Agent 凭证为空，尝试从 CC-Switch 读取当前 Provider
 */
export async function getOrchestratorAgent(): Promise<{
  platform: string; model: string; baseUrl: string; apiKey: string
}> {
  await ensureOrchestratorAgent()

  const agent = await prisma.agent.findFirst({ where: { isOrchestrator: true } })
  if (agent) {
    // 如果 Agent 凭证为空，尝试从 AppConfig/CC-Switch 读取
    if (!agent.apiKey) {
      const config = await getOrchestratorConfig()
      if (config.apiKey) {
        return { platform: agent.platform, model: config.model, baseUrl: config.baseUrl, apiKey: config.apiKey }
      }
    }
    return { platform: agent.platform, model: agent.model, baseUrl: agent.baseUrl, apiKey: agent.apiKey }
  }

  // 极端 fallback：Agent 创建失败，退回 AppConfig
  const config = await getOrchestratorConfig()
  return { platform: 'claude-code', ...config }
}

export async function callLLMForAnalysis(userPrompt: string): Promise<string> {
  const orch = await getOrchestratorAgent()
  const platform = orch.platform as AdapterConfig['platform']
  const adapter = createAdapter({ platform })
  await adapter.connect({
    platform,
    apiKey: orch.apiKey || undefined,
    model: orch.model || undefined,
    baseUrl: orch.baseUrl || undefined,
  })

  let result = ''
  try {
    for await (const chunk of withTimeout(adapter.send({ prompt: userPrompt }), TIMEOUT.LLM_CALL)) {
      if (chunk.type === 'text' || chunk.type === 'error') result += chunk.content
    }
  } finally {
    await adapter.close()
  }

  if (!result.trim()) throw new Error('LLM returned empty response')
  return result
}

async function callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  const combinedPrompt = `${systemPrompt}\n\n---\n\n用户输入：${userPrompt}\n\n你必须严格按照上述指令返回结果，不要说其他话。`

  const orch = await getOrchestratorAgent()
  const platform = orch.platform as AdapterConfig['platform']
  const adapter = createAdapter({ platform })
  await adapter.connect({
    platform,
    apiKey: orch.apiKey || undefined,
    model: orch.model || undefined,
    baseUrl: orch.baseUrl || undefined,
  })

  let result = ''
  try {
    for await (const chunk of withTimeout(adapter.send({ prompt: combinedPrompt }), TIMEOUT.LLM_CALL)) {
      if (chunk.type === 'text') {
        result += chunk.content
      } else if (chunk.type === 'error') {
        throw new Error(chunk.content)
      }
    }
  } finally {
    await adapter.close()
  }

  if (!result.trim()) throw new Error('LLM returned empty response')
  return result
}

export function parseJSON<T>(text: string, requiredKeys?: string[]): T {
  // Try direct parse first
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {}

  // Try extracting from markdown code fences
  if (parsed === undefined) {
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1].trim())
      } catch {}
    }
  }

  // Try extracting JSON object/array by finding balanced braces/brackets
  if (parsed === undefined) {
    const startObj = text.indexOf('{')
    const startArr = text.indexOf('[')
    const start = startObj === -1 ? startArr : startArr === -1 ? startObj : Math.min(startObj, startArr)

    if (start !== -1) {
      const opener = text[start]
      const closer = opener === '{' ? '}' : ']'
      let depth = 0
      for (let i = start; i < text.length; i++) {
        if (text[i] === opener) depth++
        if (text[i] === closer) depth--
        if (depth === 0) {
          try {
            parsed = JSON.parse(text.substring(start, i + 1))
          } catch {}
          break
        }
      }
    }
  }

  if (parsed === undefined) {
    throw new Error(`Failed to parse JSON from: ${text.slice(0, 200)}`)
  }

  if (requiredKeys && typeof parsed === 'object' && parsed !== null) {
    for (const key of requiredKeys) {
      if (!(key in (parsed as Record<string, unknown>))) {
        throw new Error(`Missing required field: ${key}`)
      }
    }
  }

  return parsed as T
}

export async function analyzeScene(userMessage: string): Promise<{ type: string; complexity: string; description: string }> {
  const response = await callLLM(SCENE_ANALYSIS_PROMPT, userMessage)
  return parseJSON(response, ['type', 'complexity', 'description'])
}

export async function getOrchestratorDecision(
  userMessage: string,
  agents: Array<{ name: string; expertise: string; platform: string }>,
  context: string,
  workDir?: string,
  permissionMode?: string
): Promise<{ decision: OrchestratorDecision; sessionId?: string }> {
  const agentList = agents.map(a => `- ${a.name}（${a.expertise}，平台：${a.platform}）`).join('\n')
  const systemPrompt = ORCHESTRATOR_DECISION_PROMPT.replace('{agentList}', agentList || '（无）')

  const fullPrompt = `用户消息：${userMessage}

对话历史：
${context}

请决定下一步该谁发言。`

  const orch = await getOrchestratorAgent()
  const { result: response, sessionId } = await executeSingleAgent(
    {
      name: 'Orchestrator',
      systemPrompt,
      platform: orch.platform,
      model: orch.model || undefined,
      baseUrl: orch.baseUrl || undefined,
      apiKey: orch.apiKey || undefined,
      workDir,
      permissionMode: permissionMode || 'default',
    },
    fullPrompt,
    '',
    () => {},
  )

  return { decision: parseJSON(response, ['action', 'message', 'reason']), sessionId }
}

export async function generateRoles(taskType: string, taskDescription: string): Promise<Array<{ name: string; expertise: string; systemPrompt: string; platform: string }>> {
  const response = await callLLM(ROLE_GENERATION_PROMPT, `任务类型：${taskType}\n任务描述：${taskDescription}`)
  const parsed = parseJSON<{ agents: Array<{ name: string; expertise: string; systemPrompt: string; platform: string }> }>(response, ['agents'])
  if (!parsed.agents || parsed.agents.length === 0) throw new Error('generateRoles returned empty agents list')
  return parsed.agents
}

export async function decomposeTasks(taskDescription: string, agents: Array<{ name: string; expertise: string }>): Promise<ScheduledTask[]> {
  const agentList = agents.map(a => `${a.name}（${a.expertise}）`).join('、')
  const response = await callLLM(TASK_DECOMPOSITION_PROMPT, `任务描述：${taskDescription}\n可用角色：${agentList}`)
  const parsed = parseJSON<{ tasks: Array<{ id: number; description: string; assignedAgent: string; dependencies: number[]; declared_files?: string[]; output_schema?: string[] }> }>(response, ['tasks'])

  // Generate unique IDs to avoid conflicts with existing tasks
  const idMap = new Map<number, string>()
  parsed.tasks.forEach(t => idMap.set(t.id, crypto.randomUUID()))

  const tasks: ScheduledTask[] = parsed.tasks.map(t => ({
    id: idMap.get(t.id)!,
    description: t.description,
    assignedAgent: t.assignedAgent,
    dependencies: t.dependencies.map(d => idMap.get(d)!).filter(Boolean),
    declaredFiles: t.declared_files || [],
    outputSchema: t.output_schema ? JSON.stringify(t.output_schema) : undefined,
    batch: 0,
  }))

  return topologicalSort(tasks)
}

export interface PriorTaskMeta {
  description: string
  outputSchema?: string
}

export async function executeTaskBatch(
  tasks: ScheduledTask[],
  agents: Array<{ id?: string; name: string; systemPrompt: string; platform: string; model?: string; baseUrl?: string; apiKey?: string; permissionMode?: string }>,
  onChunk: (agentId: string, chunk: StreamChunk) => void,
  chatSessionId?: string,
  projectDir?: string,
  // contract v1 §1.1: 跨批权威 result（来自 DB task.result）。本批 task 若依赖前批 task，从这里查
  priorResults?: Map<string, string>,
  // contract v1 §1.1: 前批 task 的描述 + outputSchema，用于结构化注入 <dependency> 标签
  priorTaskMeta?: Map<string, PriorTaskMeta>
): Promise<{ results: Map<string, { result: string; sessionId?: string }>, failedTaskIds: string[] }> {
  const results = new Map<string, { result: string; sessionId?: string }>()
  const agentMap = new Map(agents.map(a => [a.name, a]))
  const failedTaskIds: string[] = []

  // contract v1 §1.1: 合并 DB 中已完成 task 的 result（跨批权威），
  // 使 task.dependencies 查找时能命中前批 task 的交付物
  if (priorResults) {
    for (const [taskId, result] of priorResults) {
      results.set(taskId, { result })
    }
  }

  // contract v1 §1.1: 构建 taskId -> {description, outputSchema} 元数据查找表
  // 本批任务自己的描述/schema 直接从 tasks 取，前批的从 priorTaskMeta 补
  const taskMetaMap = new Map<string, PriorTaskMeta>()
  for (const t of tasks) {
    taskMetaMap.set(t.id, { description: t.description, outputSchema: t.outputSchema })
  }
  if (priorTaskMeta) {
    for (const [taskId, meta] of priorTaskMeta) {
      if (!taskMetaMap.has(taskId)) taskMetaMap.set(taskId, meta)
    }
  }

  // Group tasks by batch for sequential execution (same batch parallel, different batch sequential)
  const batches = new Map<number, ScheduledTask[]>()
  for (const task of tasks) {
    const batch = batches.get(task.batch) || []
    batch.push(task)
    batches.set(task.batch, batch)
  }

  for (const [, batchTasks] of batches) {
    const settled = await Promise.allSettled(batchTasks.map(async (task, index) => {
      const agent = agentMap.get(task.assignedAgent) || agents[index % agents.length]
      if (!agent) return { taskId: task.id, result: '', sessionId: undefined }

      // 依赖任务的文本结果以 <dependency> 块形式注入（见下方 depBlocks 构造）
      let result = ''
      let capturedSessionId: string | undefined

      // Design decision #20: update Agent status per-session
      const agentId = agent.id
      await updateAgentSessionStatus(chatSessionId, agentId, agent.name, 'working')

      try {
        const platform = (agent.platform || 'claude-code') as AdapterConfig['platform']
        const adapter = createAdapter({ platform })
        const mcpConfig = chatSessionId
          ? buildMCPConfig(chatSessionId, agent.name, projectDir || '')
          : undefined
        await adapter.connect({
          platform,
          workDir: projectDir,
          model: agent.model || undefined,
          baseUrl: agent.baseUrl,
          apiKey: agent.apiKey,
          permissionMode: agent.permissionMode as AdapterConfig['permissionMode'],
          mcpConfig,
          agentId: agentId,
          chatSessionId: chatSessionId,
        })

        // P0: 注入文件约束，防止越界修改
        const fileConstraint = task.declaredFiles?.length > 0
          ? `[任务边界] 只能修改: ${task.declaredFiles.join(', ')}。禁止修改其他文件。\n\n`
          : ''

        // contract v1 §1.1: 结构化注入依赖任务的交付物
        // 每个上游任务渲染成 <dependency name="..." output_schema="..."> ... </dependency>
        // 下游 LLM 看到的就是 orchestrator 决定让它看到的，不再自行选通道
        const depBlocks = task.dependencies
          .map(depId => {
            const upstreamResult = results.get(depId)?.result
            if (!upstreamResult) return ''
            const meta = taskMetaMap.get(depId)
            const name = meta?.description ?? depId
            const schemaAttr = meta?.outputSchema ? ` output_schema=${JSON.stringify(meta.outputSchema)}` : ''
            return `<dependency name=${JSON.stringify(name)}${schemaAttr}>\n${upstreamResult}\n</dependency>`
          })
          .filter(Boolean)
        const depPrefix = depBlocks.length > 0 ? depBlocks.join('\n\n') + '\n\n' : ''

        // contract v1 §1.3 P0 (动作 8): 用 <authoritative_input> 包装权威输入
        // 告知 LLM:以下内容是 orchestrator 注入的当前权威输入,与历史冲突时以此为准
        // CLI 历史在 prompt 之前由 --resume 拼接,本包装放在历史之后,利用 LLM 末尾注意力偏向引导
        const AUTHORITATIVE_HEADER =
          '<authoritative_input>\n' +
          '以下是 orchestrator 本轮注入的权威输入(依赖产出 + 任务边界 + 任务描述)。\n' +
          '如与你之前会话历史冲突,**以下内容为准**,历史记录作废。\n\n'
        const AUTHORITATIVE_FOOTER = '\n</authoritative_input>'
        const innerPrompt = depPrefix + fileConstraint + task.description
        let prompt = AUTHORITATIVE_HEADER + innerPrompt + AUTHORITATIVE_FOOTER

        // 通用 prompt 截断保护:超过上限时按比例截掉 depPrefix(保留 fileConstraint + 任务描述 + 权威包装完整)
        const MAX_PROMPT_LEN = 4000
        const wrapperLen = AUTHORITATIVE_HEADER.length + AUTHORITATIVE_FOOTER.length
        if (prompt.length > MAX_PROMPT_LEN && depPrefix) {
          const tailLen = (fileConstraint + task.description).length
          const allowedDepLen = Math.max(0, MAX_PROMPT_LEN - tailLen - wrapperLen)
          const truncatedDep = depPrefix.slice(0, allowedDepLen)
          const truncationNote = allowedDepLen < depPrefix.length
            ? '\n[...依赖内容已截断...]\n\n'
            : ''
          prompt = AUTHORITATIVE_HEADER + truncatedDep + truncationNote + fileConstraint + task.description + AUTHORITATIVE_FOOTER
          console.warn(`[executeTaskBatch] 依赖块已截断: ${depPrefix.length} -> ${truncatedDep.length} 字符`)
        }

        const registryKey = buildRegistryKey(platform, chatSessionId, agentId, projectDir)
        try {
          for await (const chunk of withTimeout(
            adapter.send({
              prompt,
              context: '',  // 不传 context，CLI 通过 session 恢复管理历史
              systemPrompt: AGENT_BEHAVIOR_RULES + '\n\n' + agent.systemPrompt,
            }),
            TIMEOUT.AGENT_TASK,
            { onTimeout: () => processRegistry.gracefulKillEntry(registryKey, { workDir: projectDir }) },
          )) {
            if (chunk.type === 'session') {
              capturedSessionId = chunk.content
            } else if (chunk.type === 'text') {
              result += chunk.content
            }
            // error chunk 不拼入 result，只通过 onChunk 发送给前端
            onChunk(task.id, chunk)
          }
        } finally {
          await adapter.close()
        }
      } finally {
        await updateAgentSessionStatus(chatSessionId, agentId, agent.name, 'idle')
      }

      // Guard: empty response
      if (!result.trim()) result = EMPTY_RESPONSE

      return { taskId: task.id, result, sessionId: capturedSessionId }
    }))

    // Write current batch results immediately so next batch can read dependencies
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i]
      const taskId = batchTasks[i].id
      if (s.status === 'fulfilled' && s.value) {
        results.set(s.value.taskId, { result: s.value.result, sessionId: s.value.sessionId })
      } else {
        failedTaskIds.push(taskId)
      }
    }
  }

  return { results, failedTaskIds }
}

export async function executeSingleAgent(
  agent: { name: string; systemPrompt: string; platform: string; model?: string; baseUrl?: string; apiKey?: string; sessionId?: string; workDir?: string; permissionMode?: string; id?: string; tools?: string },
  prompt: string,
  context: string,
  onChunk: (agentId: string, chunk: StreamChunk) => void,
  chatSessionId?: string,
  projectDir?: string,
  attachments?: TaskAttachment[]
): Promise<{ result: string; sessionId?: string }> {
  const platform = (agent.platform || 'claude-code') as AdapterConfig['platform']

  // 解析工具配置
  let toolsList: string[] = []
  if (agent.tools) {
    try {
      const parsed = JSON.parse(agent.tools)
      if (Array.isArray(parsed)) toolsList = parsed
    } catch {}
  }

  // 软引导：prompt 注入告知 LLM 可用工具（兜底）
  let effectivePrompt = prompt
  if (toolsList.length > 0) {
    effectivePrompt = `[可用工具: ${toolsList.join(', ')}]\n\n${prompt}`
  }

  // Design decision #20: update Agent status per-session
  await updateAgentSessionStatus(chatSessionId, agent.id, agent.name, 'working')

  try {
    const adapter = createAdapter({ platform })
    const mcpConfig = chatSessionId
      ? buildMCPConfig(chatSessionId, agent.name, projectDir || agent.workDir || '')
      : undefined
    await adapter.connect({
      platform,
      workDir: agent.workDir,
      model: agent.model || undefined,
      baseUrl: agent.baseUrl,
      apiKey: agent.apiKey,
      sessionId: agent.sessionId,
      permissionMode: agent.permissionMode as AdapterConfig['permissionMode'],
      mcpConfig,
      agentId: agent.id,
      chatSessionId: chatSessionId,
      allowedTools: toolsList.length > 0 ? toolsList : undefined,
    })

    let result = ''
    let capturedSessionId: string | undefined
    const registryKey = buildRegistryKey(platform, chatSessionId, agent.id, agent.workDir)
    try {
      for await (const chunk of withTimeout(
        adapter.send({
          prompt: effectivePrompt,
          context,
          systemPrompt: AGENT_BEHAVIOR_RULES + '\n\n' + agent.systemPrompt,
          attachments,
        }),
        TIMEOUT.AGENT_TASK,
        {
          onTimeout: () => processRegistry.gracefulKillEntry(registryKey, {
            workDir: agent.workDir,
            allowedTools: toolsList.length > 0 ? toolsList : undefined,
          })
        },
      )) {
        if (chunk.type === 'session') {
          capturedSessionId = chunk.content
        } else if (chunk.type === 'text') {
          result += chunk.content
        }
        // error chunk 不拼入 result，status chunk 也不拼入
        onChunk(agent.name, chunk)
      }
    } finally {
      await adapter.close()
    }

    // Guard: empty response
    if (!result.trim()) {
      onChunk(agent.name, { type: 'text', content: EMPTY_RESPONSE })
      result = EMPTY_RESPONSE
    }

    return { result, sessionId: capturedSessionId }
  } finally {
    // Design decision #20: reset Agent status per-session
    await updateAgentSessionStatus(chatSessionId, agent.id, agent.name, 'idle')
  }
}

export async function runDiscussion(
  topic: string,
  agents: Array<{ name: string; systemPrompt: string; platform?: string; model?: string; baseUrl?: string; apiKey?: string }>,
  maxRounds: number = 3,
  onChunk: (agentName: string, chunk: StreamChunk) => void,
  chatSessionId?: string,
  projectDir?: string
): Promise<string[]> {
  const opinions: string[] = []

  for (let round = 1; round <= maxRounds; round++) {
    for (const agent of agents) {
      const discussionPrompt = buildDiscussionPrompt(round, maxRounds, opinions.join('\n\n'), agent.name)
      const combinedPrompt = `${agent.systemPrompt}\n\n---\n\n${discussionPrompt}\n\n请严格按照上述角色设定发言，控制在200字以内。`

      try {
        const platform = (agent.platform || 'claude-code') as AdapterConfig['platform']
        const adapter = createAdapter({ platform })
        const mcpCfg = chatSessionId ? buildMCPConfig(chatSessionId, agent.name, projectDir || '') : undefined
        await adapter.connect({ platform, model: agent.model || undefined, baseUrl: agent.baseUrl, apiKey: agent.apiKey, mcpConfig: mcpCfg })

        let result = ''
        const registryKey = buildRegistryKey(platform, chatSessionId, undefined, projectDir)
        try {
          for await (const chunk of withTimeout(
            adapter.send({ prompt: combinedPrompt }),
            TIMEOUT.DISCUSSION,
            { onTimeout: () => processRegistry.gracefulKillEntry(registryKey, { workDir: projectDir || '' }) },
          )) {
            if (chunk.type === 'text') result += chunk.content
            onChunk(agent.name, chunk)
          }
        } finally {
          await adapter.close()
        }

        opinions.push(`${agent.name}（第${round}轮）：${result || EMPTY_RESPONSE}`)
      } catch (err) {
        if (err instanceof TimeoutError) {
          console.error('[TIMEOUT] runDiscussion', agent.name, 'round', round)
        }
        const skipMsg = err instanceof TimeoutError
          ? `[${agent.name} 讨论超时，已跳过]`
          : `[${agent.name} 讨论出错，已跳过]`
        opinions.push(`${agent.name}（第${round}轮）：${skipMsg}`)
        onChunk(agent.name, { type: 'error', content: skipMsg })
      }
    }
  }

  return opinions
}

export function formatArchitectPlan(
  tasks: ScheduledTask[],
  agents: Array<{ name: string; expertise: string }>
): string {
  const lines = ['## 架构师方案\n', '### 任务拆解：\n']
  const batches = new Map<number, ScheduledTask[]>()
  for (const t of tasks) {
    const batch = batches.get(t.batch) || []
    batch.push(t)
    batches.set(t.batch, batch)
  }
  for (const [batchNum, batchTasks] of batches) {
    lines.push(`**批次 ${batchNum + 1}（可并行）：**`)
    for (const t of batchTasks) {
      const deps = t.dependencies.length > 0 ? `，依赖：${t.dependencies.join(', ')}` : ''
      const files = t.declaredFiles.length > 0 ? `\n  修改文件：${t.declaredFiles.join(', ')}` : ''
      const schema = t.outputSchema ? `\n  产出字段：${t.outputSchema}` : ''
      lines.push(`- ${t.description} → ${t.assignedAgent}${deps}${files}${schema}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

import { join } from 'path'
import { prisma } from '@/lib/db'
import { getOrchestratorConfig, ensureOrchestratorAgent } from '@/lib/app-config'
import { createAdapter, type StreamChunk, type AdapterConfig } from '../adapter'
import type { TaskAttachment } from '../adapter/types'
import { buildMCPConfig } from '../mcp-config'
import { SCENE_ANALYSIS_PROMPT, ROLE_GENERATION_PROMPT, TASK_DECOMPOSITION_PROMPT, buildDiscussionPrompt, ORCHESTRATOR_DECISION_PROMPT } from './prompts'
import { topologicalSort, type ScheduledTask } from './scheduler'

// 隐性行为准则：自动注入所有 Agent 的 System Prompt
const AGENT_BEHAVIOR_RULES = `[行为准则] 以下规则自动生效，无需用户提醒：
1. 你是独立 Agent，不要假设自己在某个项目中工作，等用户明确告知任务
2. 未被要求时不要主动读取代码文件或项目结构
3. 初次对话时简洁介绍自身能力，等待用户指令
4. 不确定需求时先提问，不要猜测
5. 被阻塞或无法完成时明确告知原因，不要编造结果
6. 不要越界执行其他角色的职责
7. 不要执行破坏性操作（删除文件、清空数据库等）未经用户确认`

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
 */
export async function getOrchestratorAgent(): Promise<{
  platform: string; model: string; baseUrl: string; apiKey: string
}> {
  await ensureOrchestratorAgent()

  const agent = await prisma.agent.findFirst({ where: { isOrchestrator: true } })
  if (agent) {
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
  for await (const chunk of adapter.send({ prompt: userPrompt })) {
    if (chunk.type === 'text' || chunk.type === 'error') result += chunk.content
  }
  await adapter.close()

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
  for await (const chunk of adapter.send({ prompt: combinedPrompt })) {
    if (chunk.type === 'text') {
      result += chunk.content
    } else if (chunk.type === 'error') {
      await adapter.close()
      throw new Error(chunk.content)
    }
  }
  await adapter.close()

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
  context: string
): Promise<OrchestratorDecision> {
  const agentList = agents.map(a => `- ${a.name}（${a.expertise}，平台：${a.platform}）`).join('\n')
  const prompt = ORCHESTRATOR_DECISION_PROMPT.replace('{agentList}', agentList || '（无）')

  const fullPrompt = `用户消息：${userMessage}

对话历史：
${context}

请决定下一步该谁发言。`

  const response = await callLLM(prompt, fullPrompt)
  return parseJSON(response, ['action', 'message', 'reason'])
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
  const parsed = parseJSON<{ tasks: Array<{ id: number; description: string; assignedAgent: string; dependencies: number[]; declared_files?: string[] }> }>(response, ['tasks'])

  // Generate unique IDs to avoid conflicts with existing tasks
  const idMap = new Map<number, string>()
  parsed.tasks.forEach(t => idMap.set(t.id, crypto.randomUUID()))

  const tasks: ScheduledTask[] = parsed.tasks.map(t => ({
    id: idMap.get(t.id)!,
    description: t.description,
    assignedAgent: t.assignedAgent,
    dependencies: t.dependencies.map(d => idMap.get(d)!).filter(Boolean),
    declaredFiles: t.declared_files || [],
    batch: 0,
  }))

  return topologicalSort(tasks)
}

export async function executeTaskBatch(
  tasks: ScheduledTask[],
  agents: Array<{ name: string; systemPrompt: string; platform: string; model?: string; baseUrl?: string; apiKey?: string; permissionMode?: string }>,
  onChunk: (agentId: string, chunk: StreamChunk) => void,
  chatSessionId?: string,
  projectDir?: string
): Promise<{ results: Map<string, { result: string; sessionId?: string }>, failedTaskIds: string[] }> {
  const results = new Map<string, { result: string; sessionId?: string }>()
  const agentMap = new Map(agents.map(a => [a.name, a]))
  const failedTaskIds: string[] = []

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

      // 依赖任务的文本结果（拼到 prompt 中，不走 context）
      const depContext = task.dependencies
        .map(depId => results.get(depId)?.result)
        .filter(Boolean)
        .join('\n\n')

      let result = ''
      let capturedSessionId: string | undefined

      // Design decision #20: update Agent status per-session
      const agentId = (agent as any).id as string | undefined
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
        // 依赖任务结果作为 prompt 前缀
        const depPrefix = depContext ? `[依赖任务结果]\n${depContext}\n\n` : ''
        for await (const chunk of adapter.send({
          prompt: depPrefix + fileConstraint + task.description,
          context: '',  // 不传 context，CLI 通过 session 恢复管理历史
          systemPrompt: AGENT_BEHAVIOR_RULES + '\n\n' + agent.systemPrompt,
        })) {
          if (chunk.type === 'session') {
            capturedSessionId = chunk.content
          } else if (chunk.type === 'text') {
            result += chunk.content
          }
          // error chunk 不拼入 result，只通过 onChunk 发送给前端
          onChunk(task.id, chunk)
        }

        await adapter.close()
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
    for await (const chunk of adapter.send({
      prompt: effectivePrompt,
      context,
      systemPrompt: AGENT_BEHAVIOR_RULES + '\n\n' + agent.systemPrompt,
      attachments,
    })) {
      if (chunk.type === 'session') {
        capturedSessionId = chunk.content
      } else if (chunk.type === 'text') {
        result += chunk.content
      }
      // error chunk 不拼入 result，status chunk 也不拼入
      onChunk(agent.name, chunk)
    }

    await adapter.close()

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
        for await (const chunk of adapter.send({ prompt: combinedPrompt })) {
          if (chunk.type === 'text') result += chunk.content
          onChunk(agent.name, chunk)
        }

        opinions.push(`${agent.name}（第${round}轮）：${result || EMPTY_RESPONSE}`)
        await adapter.close()
      } catch {
        const skipMsg = `[${agent.name} 讨论出错，已跳过]`
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
      lines.push(`- ${t.description} → ${t.assignedAgent}${deps}${files}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

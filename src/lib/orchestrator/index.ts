import { createAdapter, type StreamChunk, type AdapterConfig } from '../adapter'
import { SCENE_ANALYSIS_PROMPT, ROLE_GENERATION_PROMPT, TASK_DECOMPOSITION_PROMPT, buildDiscussionPrompt } from './prompts'
import { topologicalSort, groupByBatch, type ScheduledTask } from './scheduler'

export async function callLLMForAnalysis(userPrompt: string): Promise<string> {
  const adapter = createAdapter({ platform: 'claude-code' })
  await adapter.connect({ platform: 'claude-code' })

  let result = ''
  for await (const chunk of adapter.send({ prompt: userPrompt })) {
    if (chunk.type === 'text') result += chunk.content
  }
  await adapter.close()
  return result
}

async function callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  const adapter = createAdapter({ platform: 'claude-code' })
  await adapter.connect({ platform: 'claude-code' })

  // Combine system prompt into user prompt since Claude Code CLI ignores --system-prompt
  const combinedPrompt = `${systemPrompt}\n\n---\n\n用户输入：${userPrompt}\n\n你必须严格按照上述指令返回结果，不要说其他话。`

  let result = ''
  for await (const chunk of adapter.send({ prompt: combinedPrompt })) {
    if (chunk.type === 'text') result += chunk.content
  }
  await adapter.close()
  return result
}

function parseJSON<T>(text: string): T {
  // Try direct parse first
  try {
    return JSON.parse(text)
  } catch {}

  // Try extracting from markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim())
    } catch {}
  }

  // Try extracting JSON object/array by finding balanced braces/brackets
  const startObj = text.indexOf('{')
  const startArr = text.indexOf('[')
  const start = startObj === -1 ? startArr : startArr === -1 ? startObj : Math.min(startObj, startArr)

  if (start !== -1) {
    // Find matching closing brace/bracket
    const opener = text[start]
    const closer = opener === '{' ? '}' : ']'
    let depth = 0
    for (let i = start; i < text.length; i++) {
      if (text[i] === opener) depth++
      if (text[i] === closer) depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.substring(start, i + 1))
        } catch {}
        break
      }
    }
  }

  throw new Error(`Failed to parse JSON from: ${text.slice(0, 200)}`)
}

export async function analyzeScene(userMessage: string): Promise<{ type: string; complexity: string; description: string }> {
  const response = await callLLM(SCENE_ANALYSIS_PROMPT, userMessage)
  return parseJSON(response)
}

export async function generateRoles(taskType: string, taskDescription: string): Promise<Array<{ name: string; expertise: string; systemPrompt: string; platform: string }>> {
  const response = await callLLM(ROLE_GENERATION_PROMPT, `任务类型：${taskType}\n任务描述：${taskDescription}`)
  const parsed = parseJSON<{ agents: Array<{ name: string; expertise: string; systemPrompt: string; platform: string }> }>(response)
  return parsed.agents
}

export async function decomposeTasks(taskDescription: string, agents: Array<{ name: string; expertise: string }>): Promise<ScheduledTask[]> {
  const agentList = agents.map(a => `${a.name}（${a.expertise}）`).join('、')
  const response = await callLLM(TASK_DECOMPOSITION_PROMPT, `任务描述：${taskDescription}\n可用角色：${agentList}`)
  const parsed = parseJSON<{ tasks: Array<{ id: number; description: string; assignedAgent: string; dependencies: number[]; declared_files?: string[] }> }>(response)

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
  agents: Array<{ name: string; systemPrompt: string; platform: string }>,
  context: string,
  onChunk: (agentId: string, chunk: StreamChunk) => void
): Promise<Map<string, string>> {
  const results = new Map<string, string>()
  const agentMap = new Map(agents.map(a => [a.name, a]))

  await Promise.all(tasks.map(async (task, index) => {
    // Match agent by name, fallback to index for encoding-garbled names
    const agent = agentMap.get(task.assignedAgent) || agents[index % agents.length]
    if (!agent) return

    const platform = (agent.platform || 'claude-code') as AdapterConfig['platform']
    const adapter = createAdapter({ platform })
    await adapter.connect({ platform })

    const depContext = task.dependencies
      .map(depId => results.get(depId))
      .filter(Boolean)
      .join('\n\n')

    const fullContext = [context, depContext].filter(Boolean).join('\n\n---\n\n')

    let result = ''
    for await (const chunk of adapter.send({
      prompt: task.description,
      context: fullContext,
      systemPrompt: agent.systemPrompt,
    })) {
      result += chunk.content
      onChunk(task.id, chunk)
    }

    results.set(task.id, result)
    await adapter.close()
  }))

  return results
}

export async function executeSingleAgent(
  agent: { name: string; systemPrompt: string; platform: string },
  prompt: string,
  context: string,
  onChunk: (agentId: string, chunk: StreamChunk) => void
): Promise<string> {
  const platform = (agent.platform || 'claude-code') as AdapterConfig['platform']
  const adapter = createAdapter({ platform })
  await adapter.connect({ platform })

  let result = ''
  for await (const chunk of adapter.send({
    prompt,
    context,
    systemPrompt: agent.systemPrompt,
  })) {
    result += chunk.content
    onChunk(agent.name, chunk)
  }

  await adapter.close()
  return result
}

export async function runDiscussion(
  topic: string,
  agents: Array<{ name: string; systemPrompt: string }>,
  maxRounds: number = 3,
  onChunk: (agentName: string, chunk: StreamChunk) => void
): Promise<string[]> {
  const opinions: string[] = []

  for (let round = 1; round <= maxRounds; round++) {
    for (const agent of agents) {
      const discussionPrompt = buildDiscussionPrompt(round, maxRounds, opinions.join('\n\n'), agent.name)
      const combinedPrompt = `${agent.systemPrompt}\n\n---\n\n${discussionPrompt}\n\n请严格按照上述角色设定发言，控制在200字以内。`

      const adapter = createAdapter({ platform: 'claude-code' })
      await adapter.connect({ platform: 'claude-code' })

      let result = ''
      for await (const chunk of adapter.send({ prompt: combinedPrompt })) {
        result += chunk.content
        onChunk(agent.name, chunk)
      }

      opinions.push(`${agent.name}（第${round}轮）：${result}`)
      await adapter.close()
    }
  }

  return opinions
}

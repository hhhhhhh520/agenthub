import { createAdapter, type StreamChunk } from '../adapter'
import { SCENE_ANALYSIS_PROMPT, ROLE_GENERATION_PROMPT, TASK_DECOMPOSITION_PROMPT, buildDiscussionPrompt } from './prompts'
import { topologicalSort, groupByBatch, type ScheduledTask } from './scheduler'

async function callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  const adapter = createAdapter({ platform: 'llm' })
  await adapter.connect({ platform: 'llm' })

  let result = ''
  for await (const chunk of adapter.send({ prompt: userPrompt, systemPrompt })) {
    if (chunk.type === 'text') result += chunk.content
  }
  await adapter.close()
  return result
}

function parseJSON<T>(text: string): T {
  // Try direct parse first
  try {
    return JSON.parse(text)
  } catch {
    // Try extracting from markdown code fences
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenceMatch) {
      return JSON.parse(fenceMatch[1].trim())
    }
    // Try extracting JSON object/array from text
    const jsonMatch = text.match(/[\[{][\s\S]*[\]}]/)
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0])
    }
    throw new Error(`Failed to parse JSON from: ${text}`)
  }
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
  const parsed = parseJSON<{ tasks: Array<{ id: number; description: string; assignedAgent: string; dependencies: number[] }> }>(response)

  const tasks: ScheduledTask[] = parsed.tasks.map(t => ({
    id: String(t.id),
    description: t.description,
    assignedAgent: t.assignedAgent,
    dependencies: t.dependencies.map(d => String(d)),
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

  await Promise.all(tasks.map(async (task) => {
    const agent = agentMap.get(task.assignedAgent)
    if (!agent) return

    const adapter = createAdapter({ platform: agent.platform as 'llm' | 'claude-code' | 'codex' })
    await adapter.connect({ platform: agent.platform as 'llm' | 'claude-code' | 'codex' })

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

export async function runDiscussion(
  topic: string,
  agents: Array<{ name: string; systemPrompt: string }>,
  maxRounds: number = 3,
  onChunk: (agentName: string, chunk: StreamChunk) => void
): Promise<string[]> {
  const opinions: string[] = []

  for (let round = 1; round <= maxRounds; round++) {
    for (const agent of agents) {
      const prompt = buildDiscussionPrompt(round, maxRounds, opinions.join('\n\n'), agent.name)

      const adapter = createAdapter({ platform: 'llm' })
      await adapter.connect({ platform: 'llm' })

      let result = ''
      for await (const chunk of adapter.send({ prompt, systemPrompt: agent.systemPrompt })) {
        result += chunk.content
        onChunk(agent.name, chunk)
      }

      opinions.push(`${agent.name}（第${round}轮）：${result}`)
      await adapter.close()
    }
  }

  return opinions
}

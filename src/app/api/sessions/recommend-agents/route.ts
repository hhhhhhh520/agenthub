import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { callLLMForAnalysis, parseJSON } from '@/lib/orchestrator'

// Quick recommendation for session creation UI.
// At runtime, the Orchestrator autonomously selects agents via delegate/discuss actions.
export async function POST(request: Request) {
  const { taskDescription } = await request.json()

  if (!taskDescription?.trim()) {
    return NextResponse.json({ error: 'taskDescription is required' }, { status: 400 })
  }

  // Security: exclude apiKey and systemPrompt from response
  // Include ALL agents (preset + user-created) so custom agents appear in group dialog
  const agents = await prisma.agent.findMany({
    select: {
      id: true, name: true, expertise: true, platform: true, model: true,
      baseUrl: true, isPreset: true, accentColor: true, capabilities: true, status: true, tools: true,
    },
    orderBy: { name: 'asc' },
  })

  if (agents.length === 0) {
    return NextResponse.json({ recommendedIds: [], allAgents: [] })
  }

  const agentList = agents.map(a => `- ${a.name}（${a.expertise}）`).join('\n')

  const prompt = `你是一个任务分析器。根据用户的需求描述，从可用 Agent 列表中选择需要参与的 Agent。

可用 Agent：
${agentList}

用户需求：${taskDescription}

规则：
- 只选择完成任务确实需要的 Agent
- 必须返回一个 JSON 数组，包含推荐的 Agent 名称
- 不要返回其他内容

返回格式（只返回 JSON，不要代码块）：
["Agent名称1", "Agent名称2"]`

  let recommendedNames: string[] = []
  let llmFailed = false
  try {
    const result = await callLLMForAnalysis(prompt)
    const match = result.match(/\[[\s\S]*?\]/)
    if (match) {
      recommendedNames = JSON.parse(match[0])
    }
  } catch {
    llmFailed = true
  }

  if (recommendedNames.length === 0) {
    recommendedNames = agents.map(a => a.name)
  }

  const recommendedIds = agents
    .filter(a => recommendedNames.includes(a.name))
    .map(a => a.id)

  // Always include Orchestrator in recommended agents for coordination
  const orchestrator = agents.find(a => a.name === 'Orchestrator')
  if (orchestrator && !recommendedIds.includes(orchestrator.id)) {
    recommendedIds.push(orchestrator.id)
  }

  return NextResponse.json({ recommendedIds, allAgents: agents, llmUnavailable: llmFailed })
}

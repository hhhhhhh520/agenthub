import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { callLLMForAnalysis } from '@/lib/orchestrator'

export async function POST(request: Request) {
  const { taskDescription } = await request.json()

  if (!taskDescription?.trim()) {
    return NextResponse.json({ error: 'taskDescription is required' }, { status: 400 })
  }

  const agents = await prisma.agent.findMany({
    where: { isPreset: true },
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
  try {
    const result = await callLLMForAnalysis(prompt)
    // Extract JSON array from response
    const match = result.match(/\[[\s\S]*?\]/)
    if (match) {
      recommendedNames = JSON.parse(match[0])
    }
  } catch {
    // LLM failed, fall back to all presets
  }

  // If LLM returned nothing, recommend all
  if (recommendedNames.length === 0) {
    recommendedNames = agents.map(a => a.name)
  }

  // Map names to IDs
  const recommendedIds = agents
    .filter(a => recommendedNames.includes(a.name))
    .map(a => a.id)

  return NextResponse.json({ recommendedIds, allAgents: agents })
}

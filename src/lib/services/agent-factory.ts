import { prisma } from '@/lib/db'
import { callLLMForAnalysis, parseJSON } from '@/lib/orchestrator'
import type { SendEvent } from './review'

export async function handleCreateAgent(
  message: string,
  sessionId: string,
  sendEvent: SendEvent
) {
  sendEvent({ agentId: 'orchestrator', type: 'status', content: '正在生成 Agent 配置...' })

  const configPrompt = `从用户消息中提取 Agent 配置，返回 JSON（不要其他话）：
{"name":"角色名","expertise":"专长描述","systemPrompt":"系统提示词","platform":"claude-code","capabilities":["标签1","标签2"],"accentColor":"#hex色"}

用户消息：${message}`

  const configText = await callLLMForAnalysis(configPrompt)
  let config: { name: string; expertise: string; systemPrompt: string; platform?: string; capabilities?: string[]; accentColor?: string }
  try {
    config = parseJSON(configText, ['name', 'expertise', 'systemPrompt'])
  } catch {
    sendEvent({ agentId: 'orchestrator', type: 'error', content: 'Agent 配置解析失败，请重试' })
    return
  }

  const existing = await prisma.agent.findUnique({ where: { name: config.name } })
  if (existing) {
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

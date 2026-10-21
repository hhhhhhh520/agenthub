import { prisma } from '@/lib/db'
import { callLLMForAnalysis, parseJSON } from '@/lib/orchestrator'
import { isSessionCancelled, SessionCancelledError } from '@/lib/cancellation'
import type { SendEvent } from './review'

function sendStopped(sendEvent: SendEvent) {
  sendEvent({ agentId: 'orchestrator', type: 'text', content: '执行已停止' })
  sendEvent({ agentId: 'orchestrator', type: 'done', content: '执行已停止' })
}

export async function handleCreateAgent(
  message: string,
  sessionId: string,
  sendEvent: SendEvent
) {
  if (isSessionCancelled(sessionId)) {
    sendStopped(sendEvent)
    return
  }
  sendEvent({ agentId: 'orchestrator', type: 'status', content: '正在生成 Agent 配置...' })

  const configPrompt = `从用户消息中提取 Agent 配置，返回 JSON（不要其他话）：
{"name":"角色名","expertise":"专长描述","systemPrompt":"系统提示词","platform":"claude-code","capabilities":["标签1","标签2"],"accentColor":"#hex色"}

用户消息：${message}`

  const configText = await callLLMForAnalysis(configPrompt, sessionId)
  let config: { name: string; expertise: string; systemPrompt: string; platform?: string; capabilities?: string[]; accentColor?: string }
  try {
    config = parseJSON(configText, ['name', 'expertise', 'systemPrompt'])
  } catch {
    sendEvent({ agentId: 'orchestrator', type: 'error', content: 'Agent 配置解析失败，请重试' })
    return
  }

  // P2-09: LLM 返回后可能已被 stop/delete，不能再开始 DB 写入。
  if (isSessionCancelled(sessionId)) {
    sendStopped(sendEvent)
    return
  }

  const existing = await prisma.agent.findUnique({ where: { name: config.name } })
  if (existing) {
    const suffix = Date.now().toString(36).slice(-4)
    config.name = `${config.name}_${suffix}`
  }

  const platform = config.platform || 'claude-code'
  const capabilities = config.capabilities || []
  const promptPreview = config.systemPrompt.length > 100 ? config.systemPrompt.slice(0, 100) + '...' : config.systemPrompt
  const result = `已创建 Agent「${config.name}」\n专长：${config.expertise}\n平台：${platform}${capabilities.length ? '\n能力：' + capabilities.join('、') : ''}\n系统提示词：${promptPreview}\n\n如需修改，请在 Agent 面板中编辑。`

  // Agent、成员、消息同一事务：取消或任一步失败都不能留下“半个 Agent”。
  try {
    await prisma.$transaction(async (tx) => {
      if (isSessionCancelled(sessionId)) throw new SessionCancelledError(sessionId)
      const agent = await tx.agent.create({
        data: {
          name: config.name,
          expertise: config.expertise,
          systemPrompt: config.systemPrompt,
          platform,
          capabilities: JSON.stringify(capabilities),
          accentColor: config.accentColor || '#6366f1',
          isPreset: false,
        },
      })
      if (isSessionCancelled(sessionId)) throw new SessionCancelledError(sessionId)
      await tx.sessionMember.create({
        data: { sessionId, agentId: agent.id },
      })
      if (isSessionCancelled(sessionId)) throw new SessionCancelledError(sessionId)
      await tx.message.create({
        data: { role: 'orchestrator', rawContent: result, sessionId },
      })
      if (isSessionCancelled(sessionId)) throw new SessionCancelledError(sessionId)
    })
  } catch (err) {
    if (isSessionCancelled(sessionId) || err instanceof SessionCancelledError) {
      sendStopped(sendEvent)
      return
    }
    throw err
  }

  if (isSessionCancelled(sessionId)) {
    sendStopped(sendEvent)
    return
  }
  sendEvent({ agentId: 'orchestrator', type: 'text', content: result })
  sendEvent({ agentId: 'orchestrator', type: 'done', content: result })
}

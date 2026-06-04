import { prisma } from '@/lib/db'
import { executeSingleAgent, runDiscussion } from '@/lib/orchestrator'
import { acquireSessionLock } from '@/lib/session-lock'
import { buildContextFromHistory } from '@/lib/services/context-builder'
import { reviewResult } from '@/lib/services/review'
import { handleCreateAgent } from '@/lib/services/agent-factory'
import { handleOrchestratorDecision, handleOrchestratorChat } from '@/lib/services/chat-router'
import type { TaskAttachment } from '@/lib/adapter/types'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params

  const releaseLock = await acquireSessionLock(sessionId, request.signal)

  let message: string, mentionAll: boolean | undefined, targetAgent: string | undefined, replyToId: string | undefined, regenerate: string | undefined, attachmentIds: string[] | undefined
  try {
    ({ message, mentionAll, targetAgent, replyToId, regenerate, attachmentIds } = await request.json())
  } catch {
    return new Response('Invalid JSON body', { status: 400 })
  }
  // Allow empty message if attachments or regenerate are present
  if ((!message || typeof message !== 'string') && (!attachmentIds || attachmentIds.length === 0) && !regenerate) {
    return new Response('message is required and must be a string', { status: 400 })
  }
  message = message || ''

  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  if (!session) {
    return new Response('Session not found', { status: 404 })
  }

  const permissionMode = session.permissionMode as 'default' | 'auto'
  const workDir = session.projectDir && session.projectDir.trim()
    ? session.projectDir.trim()
    : process.cwd()

  // /permission command
  if (message.trim().startsWith('/permission')) {
    const args = message.trim().split(/\s+/)
    const newMode = args[1]

    if (newMode === 'auto' || newMode === 'default') {
      await prisma.session.update({ where: { id: sessionId }, data: { permissionMode: newMode } })
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          const content = newMode === 'auto'
            ? '已切换到自动模式，Agent 操作将自动执行，无需确认。'
            : '已切换到默认模式，Agent 操作需要用户确认。'
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ agentId: 'orchestrator', type: 'text', content })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ agentId: 'orchestrator', type: 'done', content })}\n\n`))
          controller.close()
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } })
    } else {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          const content = '用法：/permission auto 或 /permission default\n\n- auto: 自动模式，减少打扰\n- default: 默认模式，需要确认每次操作'
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ agentId: 'orchestrator', type: 'text', content })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ agentId: 'orchestrator', type: 'done', content })}\n\n`))
          controller.close()
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } })
    }
  }

  // Fetch attachments if provided
  let msgAttachments: TaskAttachment[] = []
  if (attachmentIds && attachmentIds.length > 0) {
    msgAttachments = await prisma.attachment.findMany({
      where: { id: { in: attachmentIds }, sessionId },
    }) as TaskAttachment[]
  }

  if (!regenerate) {
    const userMsg = await prisma.message.create({
      data: { role: 'user', rawContent: message, sessionId, replyToId },
    })
    // Link attachments to the message
    if (attachmentIds && attachmentIds.length > 0) {
      await prisma.attachment.updateMany({
        where: { id: { in: attachmentIds }, sessionId },
        data: { messageId: userMsg.id },
      })
    }
  }

  const encoder = new TextEncoder()
  const SSE_TIMEOUT_MS = 5 * 60_000
  const stream = new ReadableStream({
    async start(controller) {
      function sendEvent(data: { agentId: string; type: string; content: string; messageId?: string; data?: { requestId?: string; toolName?: string; toolInput?: Record<string, unknown>; quality?: string } }) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      }

      const sseTimeout = setTimeout(() => {
        sendEvent({ agentId: 'orchestrator', type: 'error', content: '请求超时（5分钟），请重试' })
        controller.close()
      }, SSE_TIMEOUT_MS)

      try {
        const existingMembers = await prisma.sessionMember.findMany({
          where: { sessionId },
          include: { agent: true },
        })
        const existingAgents = existingMembers.map(m => m.agent)

        if (regenerate) {
          const original = await prisma.message.findUnique({ where: { id: regenerate }, include: { attachments: true } })
          if (!original || original.sessionId !== sessionId) {
            sendEvent({ agentId: 'orchestrator', type: 'error', content: '原消息不存在' })
          } else {
            const agent = original.agentId ? existingAgents.find(a => a.name === original.agentId) : null
            const agentName = agent?.name || 'orchestrator'
            sendEvent({ agentId: agentName, type: 'status', content: '重新生成中...' })

            const { result } = await executeSingleAgent(
              { name: agentName, systemPrompt: agent?.systemPrompt || '', platform: agent?.platform || 'llm', model: agent?.model, baseUrl: agent?.baseUrl, apiKey: agent?.apiKey, workDir, permissionMode },
              original.rawContent,
              '',
              (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content, data: chunk.data }),
              undefined,
              undefined,
              original.attachments as TaskAttachment[]
            )

            await prisma.message.update({ where: { id: regenerate }, data: { rawContent: result } })
            sendEvent({ agentId: agentName, type: 'done', content: result, messageId: regenerate })
          }
        } else if (mentionAll && existingAgents.length > 0) {
          sendEvent({ agentId: 'orchestrator', type: 'status', content: '开始多轮讨论...' })

          const opinions = await runDiscussion(
            message,
            existingAgents.map(a => ({ name: a.name, systemPrompt: a.systemPrompt, platform: a.platform, model: a.model, baseUrl: a.baseUrl, apiKey: a.apiKey })),
            3,
            (agentName, chunk) => sendEvent({ agentId: agentName, type: chunk.type, content: chunk.content, data: chunk.data })
          )

          const summary = opinions.join('\n\n')
          await prisma.message.create({ data: { role: 'orchestrator', rawContent: summary, sessionId } })
          sendEvent({ agentId: 'orchestrator', type: 'done', content: summary })
        } else if (targetAgent) {
          const agent = existingAgents.find(a => a.name === targetAgent)
          if (!agent) {
            sendEvent({ agentId: 'orchestrator', type: 'error', content: `未找到名为 ${targetAgent} 的 Agent` })
          } else {
            const history = await prisma.message.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' }, include: { attachments: true } })
            const context = buildContextFromHistory(history)

            sendEvent({ agentId: agent.name, type: 'status', content: '执行中...' })
            const { result } = await executeSingleAgent(
              { name: agent.name, systemPrompt: agent.systemPrompt, platform: agent.platform, model: agent.model, baseUrl: agent.baseUrl, apiKey: agent.apiKey, workDir, permissionMode },
              message,
              context,
              (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content, data: chunk.data }),
              sessionId,
              workDir,
              msgAttachments
            )
            await prisma.message.create({ data: { role: 'agent', rawContent: result, sessionId, agentId: agent.name } })
            const { quality: mentionQuality } = await reviewResult(result, message, sessionId, sendEvent)
            sendEvent({ agentId: agent.name, type: 'done', content: result, data: { quality: mentionQuality } })
          }
        } else if (session.type === 'private' && existingAgents.length > 0) {
          const agent = existingAgents[0]
          try {
            sendEvent({ agentId: agent.name, type: 'status', content: '思考中...' })
            const { result } = await executeSingleAgent(
              { name: agent.name, systemPrompt: agent.systemPrompt, platform: agent.platform, model: agent.model, baseUrl: agent.baseUrl, apiKey: agent.apiKey, workDir, permissionMode },
              message,
              '',
              (agentId, chunk) => sendEvent({ agentId, type: chunk.type, content: chunk.content, data: chunk.data }),
              undefined,
              undefined,
              msgAttachments
            )
            await prisma.message.create({ data: { role: 'agent', rawContent: result, sessionId, agentId: agent.name } })
            const { quality: privQuality } = await reviewResult(result, message, sessionId, sendEvent)
            sendEvent({ agentId: agent.name, type: 'done', content: result, data: { quality: privQuality } })
          } catch (err) {
            sendEvent({ agentId: agent.name, type: 'error', content: `执行失败: ${err instanceof Error ? err.message : String(err)}` })
          }
        } else {
          const isCreateIntent = /创建|新建|添加|帮我建|create.*agent|建一?个/i.test(message) && /agent|智能体|助手/i.test(message)

          if (isCreateIntent) {
            await handleCreateAgent(message, sessionId, sendEvent)
          } else {
            await handleOrchestratorDecision(message, sessionId, existingAgents, sendEvent, session.phase, msgAttachments)
          }
        }
      } catch (error) {
        sendEvent({ agentId: 'orchestrator', type: 'error', content: String(error) })
      } finally {
        clearTimeout(sseTimeout)
        controller.close()
        releaseLock()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}

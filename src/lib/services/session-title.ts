import { prisma } from '@/lib/db'
import { deriveSessionTitle, isPlaceholderSessionTitle } from '@/lib/session-list'

/**
 * 首条用户消息自动命名。
 *
 * 约束：
 * - 只覆盖系统占位标题（新会话/新项目/与 Orchestrator 对话/私聊: xxx）；
 *   用户手动改过的标题永不覆盖。
 * - 只在会话还没有任何用户消息时执行，后续消息不反复改名。
 * - 只写 Session.title，不改 Message.rawContent。
 */
export async function maybeAutoTitleSession(opts: {
  sessionId: string
  currentTitle: string | null | undefined
  message: string
  regenerate?: boolean
}): Promise<string | null> {
  const { sessionId, currentTitle, message, regenerate } = opts
  if (regenerate) return null
  if (!isPlaceholderSessionTitle(currentTitle)) return null

  const title = deriveSessionTitle(message)
  if (!title) return null

  const existingUserMessages = await prisma.message.count({
    where: { sessionId, role: 'user' },
  })
  if (existingUserMessages > 0) return null

  await prisma.session.update({
    where: { id: sessionId },
    data: { title },
  })
  return title
}

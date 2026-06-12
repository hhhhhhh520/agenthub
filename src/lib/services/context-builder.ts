import { parseMessage } from '@/lib/message-parser'
import { prisma } from '@/lib/db'

interface HistoryMessage {
  role: string
  agentId?: string | null
  rawContent: string
  isPinned?: boolean
  attachments?: Array<{ filename: string; mimeType: string; path?: string }>
}

export function buildContextFromHistory(history: HistoryMessage[]): string {
  const pinned = history.filter(m => m.isPinned)
  const normal = history.filter(m => !m.isPinned)

  const format = (m: HistoryMessage) => {
    const role = m.role === 'user' ? 'User' : m.agentId || 'Agent'
    // 去掉讨论摘要标记前缀，避免污染上下文
    const cleanContent = m.rawContent.startsWith('[DISCUSSION_SUMMARY]')
      ? m.rawContent.slice(m.rawContent.indexOf(']', m.rawContent.indexOf(']') + 1) + 1)
      : m.rawContent
    const parsed = parseMessage(cleanContent)
    let content = parsed.text

    // Include attachment info
    if (m.attachments && m.attachments.length > 0) {
      const attInfo = m.attachments
        .map(a => a.mimeType.startsWith('image/') ? `[图片: ${a.filename}]` : `[文件: ${a.filename}]`)
        .join(' ')
      content = `${attInfo}\n${content}`
    }

    if (parsed.codeBlocks.length > 0) {
      content += '\n\n[代码块]\n' + parsed.codeBlocks.map(b => '```' + (b.language || '') + '\n' + b.code + '\n```').join('\n')
    }
    if (parsed.artifacts.length > 0) {
      content += '\n\n[工件: ' + parsed.artifacts.map(a => a.meta.filePath || a.type).join(', ') + ']'
    }
    return `--- ${role} ---\n${content}`
  }

  let context = ''
  if (pinned.length > 0) {
    context += '=== 重要上下文（用户标记） ===\n'
    context += pinned.map(format).join('\n\n')
    context += '\n\n=== 对话历史 ===\n'
  }
  context += normal.map(format).join('\n\n')
  return context
}

const DISCUSSION_PREFIX = '[DISCUSSION_SUMMARY]'
const STATUS_FAILED = '[STATUS:failed]'
const MAX_DISCUSSION_LEN = 500

/**
 * 按句子边界截断文本，避免切断句子产生误导
 */
function truncateAtSentence(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  const truncated = text.slice(0, maxLen)
  // 找最后一个句子结束符
  const lastPeriod = Math.max(
    truncated.lastIndexOf('。'),
    truncated.lastIndexOf('！'),
    truncated.lastIndexOf('\n'),
  )
  // 如果句子结束符在 50% 位置之后，在此处截断；否则硬截断
  return lastPeriod > maxLen * 0.5 ? truncated.slice(0, lastPeriod + 1) : truncated
}

/**
 * 从 Message 表提取最近一次成功的讨论结论
 * @returns 讨论摘要字符串，无讨论时返回空字符串
 */
export async function buildDiscussionSummary(sessionId: string): Promise<string> {
  try {
    // 查询最近的讨论消息
    const message = await prisma.message.findFirst({
      where: {
        sessionId,
        role: 'orchestrator',
        rawContent: { startsWith: DISCUSSION_PREFIX },
      },
      orderBy: { createdAt: 'desc' },
    })

    if (!message) return ''

    let content = message.rawContent

    // 检查是否成功
    if (content.includes(STATUS_FAILED)) return ''

    // 去掉标记前缀 [DISCUSSION_SUMMARY][STATUS:success]
    const statusEnd = content.indexOf(']', DISCUSSION_PREFIX.length)
    if (statusEnd === -1) return ''
    content = content.slice(statusEnd + 1)

    // 过滤无价值内容（超时/出错的 Agent）
    const lines = content.split('\n\n').filter(
      line => !line.includes('讨论超时') && !line.includes('讨论出错') && !line.includes('未返回有效内容')
    )
    if (lines.length === 0) return ''

    // 拼接并截断
    const summary = lines.join('\n\n')
    return truncateAtSentence(summary, MAX_DISCUSSION_LEN)
  } catch (error) {
    console.warn('[buildDiscussionSummary] 提取讨论摘要失败:', error)
    return ''  // 异常时返回空字符串，不阻塞主流程
  }
}

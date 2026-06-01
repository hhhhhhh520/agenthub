import { parseMessage } from '@/lib/message-parser'

export function buildContextFromHistory(
  history: Array<{ role: string; agentId?: string | null; rawContent: string; isPinned?: boolean }>
): string {
  const pinned = history.filter(m => m.isPinned)
  const normal = history.filter(m => !m.isPinned)

  const format = (m: typeof history[0]) => {
    const role = m.role === 'user' ? 'User' : m.agentId || 'Agent'
    const parsed = parseMessage(m.rawContent)
    let content = parsed.text
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

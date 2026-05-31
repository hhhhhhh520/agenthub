import { parseMessage } from '@/lib/message-parser'

export function buildContextFromHistory(history: Array<{ role: string; agentId?: string | null; rawContent: string }>): string {
  return history.map(m => {
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
  }).join('\n\n')
}

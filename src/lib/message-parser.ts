export interface CodeBlock {
  language: string
  code: string
  lineStart: number
}

export interface Artifact {
  type: string
  content: string
  meta: Record<string, string>
}

export interface ParsedMessage {
  text: string
  codeBlocks: CodeBlock[]
  artifacts: Artifact[]
}

/**
 * 内部协议前缀只用于编排/审计，不该出现在聊天 UI 或任务卡里。
 * 这里只处理「开头」的标记，避免误伤正文中正常出现的同名字符串。
 *
 * 例：
 * - `[DISCUSSION_SUMMARY][STATUS:success]前端工程师...`
 * - `[REPLAN]未能生成有效任务方案...`
 * - `[PLAN_APPROVED]plan-<id>`
 * - `[系统验证任务] 验证以下代码任务...`
 */
const LEADING_PROTOCOL_MARKERS: readonly RegExp[] = [
  /^\[DISCUSSION_SUMMARY\]/i,
  /^\[STATUS:[^\]]*\]/i,
  /^\[REPLAN-EXHAUSTED\]/i,
  /^\[REPLAN\]/i,
  /^\[PLAN_APPROVED\]plan-[0-9a-z-]+/i,
  /^\[系统验证任务\]/,
]

/**
 * 去掉消息/任务开头的内部协议标记，保留正文。
 * 只用于展示层；数据库 rawContent 必须保持原样（审计、回放、协议逻辑都依赖原文）。
 */
export function stripProtocolMarkers(rawContent: string): string {
  if (!rawContent) return ''

  let text = rawContent
  let changed = true
  while (changed) {
    changed = false

    // 标记之间可能隔着空格/换行（例如 "[DISCUSSION_SUMMARY] [STATUS:success]"）
    const trimmed = text.replace(/^\s+/, '')
    if (trimmed !== text) {
      text = trimmed
      changed = true
    }

    for (const marker of LEADING_PROTOCOL_MARKERS) {
      const next = text.replace(marker, '')
      if (next !== text) {
        text = next
        changed = true
      }
    }
  }

  return text.trimStart()
}

export function parseMessage(rawContent: string): ParsedMessage {
  if (!rawContent) {
    return { text: '', codeBlocks: [], artifacts: [] }
  }

  const codeBlocks: CodeBlock[] = []
  const artifacts: Artifact[] = []
  let remaining = rawContent

  // Extract code blocks: ```lang\ncode\n``` (also CRLF)
  remaining = remaining.replace(/```(\w*)\r?\n([\s\S]*?)```/g, (_match, lang, code, offset) => {
    codeBlocks.push({
      language: lang || 'text',
      code: code.trimEnd(),
      lineStart: rawContent.slice(0, offset).split('\n').length,
    })
    return `\n__CODE_BLOCK_${codeBlocks.length - 1}__\n`
  })

  // Extract artifacts: <!-- artifact:type key=value -->...<!-- /artifact -->
  remaining = remaining.replace(
    /<!-- artifact:(\w+)\s*(.*?)-->([\s\S]*?)<!-- \/artifact -->/g,
    (_match, type, metaStr, content) => {
      const meta: Record<string, string> = {}
      metaStr.trim().split(/\s+/).forEach((pair: string) => {
        const separator = pair.indexOf('=')
        if (separator <= 0) return
        const k = pair.slice(0, separator)
        const v = pair.slice(separator + 1)
        if (k && v) meta[k] = v
      })
      artifacts.push({ type, content: content.trim(), meta })
      return `\n__ARTIFACT_${artifacts.length - 1}__\n`
    }
  )

  // 代码块/工件先抽出来，再清理协议前缀：这样 lineStart 仍按 rawContent 计算，
  // 且代码块内部的同名字符串不会被误删。
  const text = stripProtocolMarkers(remaining).trim()

  return { text, codeBlocks, artifacts }
}

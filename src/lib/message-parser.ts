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

  const text = remaining.trim()

  return { text, codeBlocks, artifacts }
}

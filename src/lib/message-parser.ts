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
  let lineOffset = 0

  // Extract code blocks: ```lang\ncode\n```
  remaining = remaining.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    codeBlocks.push({
      language: lang || 'text',
      code: code.trimEnd(),
      lineStart: lineOffset,
    })
    lineOffset++
    return `\n__CODE_BLOCK_${codeBlocks.length - 1}__\n`
  })

  // Extract artifacts: <!-- artifact:type key=value -->...<!-- /artifact -->
  remaining = remaining.replace(
    /<!-- artifact:(\w+)\s*(.*?)-->([\s\S]*?)<!-- \/artifact -->/g,
    (_match, type, metaStr, content) => {
      const meta: Record<string, string> = {}
      metaStr.trim().split(/\s+/).forEach((pair: string) => {
        const [k, v] = pair.split('=')
        if (k && v) meta[k] = v
      })
      artifacts.push({ type, content: content.trim(), meta })
      return `\n__ARTIFACT_${artifacts.length - 1}__\n`
    }
  )

  const text = remaining.trim()

  return { text, codeBlocks, artifacts }
}

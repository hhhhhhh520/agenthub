import { describe, it, expect } from 'vitest'
import { parseMessage, stripProtocolMarkers } from '../src/lib/message-parser'

describe('parseMessage', () => {
  it('should parse plain text without code blocks', () => {
    const result = parseMessage('Hello, this is plain text.')
    expect(result.text).toBe('Hello, this is plain text.')
    expect(result.codeBlocks).toHaveLength(0)
    expect(result.artifacts).toHaveLength(0)
  })

  it('should parse empty string', () => {
    const result = parseMessage('')
    expect(result.text).toBe('')
    expect(result.codeBlocks).toHaveLength(0)
  })

  it('should extract a single code block', () => {
    const input = 'Here is some code:\n```javascript\nconsole.log("hello")\n```\nEnd of message.'
    const result = parseMessage(input)

    expect(result.codeBlocks).toHaveLength(1)
    expect(result.codeBlocks[0].language).toBe('javascript')
    expect(result.codeBlocks[0].code).toBe('console.log("hello")')
  })

  it('should extract multiple code blocks', () => {
    const input = `
\`\`\`python
print("first")
\`\`\`
Some text between
\`\`\`typescript
const x: number = 1
\`\`\`
`
    const result = parseMessage(input)

    expect(result.codeBlocks).toHaveLength(2)
    expect(result.codeBlocks[0].language).toBe('python')
    expect(result.codeBlocks[1].language).toBe('typescript')
  })

  it('should handle code block without language', () => {
    const input = '```\nplain code\n```'
    const result = parseMessage(input)

    expect(result.codeBlocks).toHaveLength(1)
    expect(result.codeBlocks[0].language).toBe('text')
  })

  it('should extract artifact with metadata', () => {
    const input = `
<!-- artifact:webpreview url=https://example.com -->
<div>Preview content</div>
<!-- /artifact -->
`
    const result = parseMessage(input)

    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0].type).toBe('webpreview')
    expect(result.artifacts[0].meta.url).toBe('https://example.com')
    expect(result.artifacts[0].content).toContain('Preview content')
  })

  it('should extract multiple artifacts', () => {
    const input = `
<!-- artifact:filecard name=app.ts -->
File content here
<!-- /artifact -->

<!-- artifact:diff file=README.md -->
+ Added line
- Removed line
<!-- /artifact -->
`
    const result = parseMessage(input)

    expect(result.artifacts).toHaveLength(2)
    expect(result.artifacts[0].type).toBe('filecard')
    expect(result.artifacts[1].type).toBe('diff')
  })

  it('should handle mixed content with code blocks and artifacts', () => {
    const input = `
Here's the code:

\`\`\`typescript
const x = 1
\`\`\`

And here's the preview:

<!-- artifact:webpreview url=/demo -->
<div>Demo</div>
<!-- /artifact -->
`
    const result = parseMessage(input)

    expect(result.codeBlocks).toHaveLength(1)
    expect(result.artifacts).toHaveLength(1)
    expect(result.text).toContain('Here\'s the code:')
    expect(result.text).toContain('And here\'s the preview:')
  })

  it('should handle artifact with multiple metadata attributes', () => {
    const input = `
<!-- artifact:link href=https://example.com title=Example -->
Link text
<!-- /artifact -->
`
    const result = parseMessage(input)

    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0].meta.href).toBe('https://example.com')
    expect(result.artifacts[0].meta.title).toBe('Example')
  })

  it('should parse code fences with CRLF line endings', () => {
    const input = 'Here is code:\r\n```typescript\r\nconst x = 1\r\n```\r\nEnd.'
    const result = parseMessage(input)

    expect(result.codeBlocks).toHaveLength(1)
    expect(result.codeBlocks[0].language).toBe('typescript')
    expect(result.codeBlocks[0].code).toBe('const x = 1')
    expect(result.text).toContain('Here is code:')
    expect(result.text).toContain('End.')
  })

  it('should report the real 1-based start line of each code fence', () => {
    const input = [
      'before',
      '```js',
      'const a = 1',
      '```',
      'middle',
      '```py',
      'print(1)',
      '```',
    ].join('\n')
    const result = parseMessage(input)

    expect(result.codeBlocks.map(b => b.lineStart)).toEqual([2, 6])
  })

  it('should keep equals signs inside artifact metadata values', () => {
    const input = '<!-- artifact:link href=https://example.com/?a=b title=A=B -->x<!-- /artifact -->'
    const result = parseMessage(input)

    expect(result.artifacts[0].meta.href).toBe('https://example.com/?a=b')
    expect(result.artifacts[0].meta.title).toBe('A=B')
  })
})

describe('stripProtocolMarkers', () => {
  it('strips discussion summary + status prefix', () => {
    expect(stripProtocolMarkers('[DISCUSSION_SUMMARY][STATUS:success]前端工程师（第1轮）：建议用 React'))
      .toBe('前端工程师（第1轮）：建议用 React')
  })

  it('strips markers separated by whitespace', () => {
    expect(stripProtocolMarkers('[DISCUSSION_SUMMARY] [STATUS:failed]\n需求不够具体'))
      .toBe('需求不够具体')
  })

  it('strips replan prefixes', () => {
    expect(stripProtocolMarkers('[REPLAN]未能生成有效任务方案')).toBe('未能生成有效任务方案')
    expect(stripProtocolMarkers('[REPLAN-EXHAUSTED]连续 3 次未能生成有效任务方案'))
      .toBe('连续 3 次未能生成有效任务方案')
  })

  it('strips plan approval records', () => {
    expect(stripProtocolMarkers('[PLAN_APPROVED]plan-abc123')).toBe('')
  })

  it('strips the system verification task prefix', () => {
    expect(stripProtocolMarkers('[系统验证任务] 验证以下代码任务')).toBe('验证以下代码任务')
  })

  it('only strips markers at the beginning', () => {
    expect(stripProtocolMarkers('说明 [STATUS:success] 的含义')).toBe('说明 [STATUS:success] 的含义')
  })

  it('returns empty string for empty input', () => {
    expect(stripProtocolMarkers('')).toBe('')
  })
})

describe('parseMessage protocol cleanup', () => {
  it('cleans display text but keeps protocol-like strings inside code blocks', () => {
    const input = '[DISCUSSION_SUMMARY][STATUS:success]报告如下：\n\n```js\nconst tag = "[REPLAN] not a real marker"\n```'
    const result = parseMessage(input)

    expect(result.text).toContain('报告如下')
    expect(result.text).not.toContain('[DISCUSSION_SUMMARY]')
    expect(result.text).not.toContain('[STATUS:')
    expect(result.codeBlocks).toHaveLength(1)
    expect(result.codeBlocks[0].code).toContain('[REPLAN] not a real marker')
  })

  it('keeps code fence line numbers when a protocol prefix exists', () => {
    const input = '[DISCUSSION_SUMMARY][STATUS:success]\n```js\nconst x = 1\n```'
    const result = parseMessage(input)

    expect(result.codeBlocks).toHaveLength(1)
    expect(result.codeBlocks[0].lineStart).toBe(2)
  })
})

import { describe, it, expect } from 'vitest'
import { parseMessage } from '../src/lib/message-parser'

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
})

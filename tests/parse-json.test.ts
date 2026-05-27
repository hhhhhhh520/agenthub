import { describe, it, expect } from 'vitest'
import { parseJSON } from '../src/lib/orchestrator/index'

describe('parseJSON', () => {
  it('should parse valid JSON string', () => {
    const result = parseJSON<{ name: string }>('{"name": "test"}')
    expect(result.name).toBe('test')
  })

  it('should parse valid JSON array', () => {
    const result = parseJSON<number[]>('[1, 2, 3]')
    expect(result).toEqual([1, 2, 3])
  })

  it('should extract JSON from markdown code fence', () => {
    const input = `
Here is the result:
\`\`\`json
{"action": "delegate", "target": "agent1"}
\`\`\`
`
    const result = parseJSON<{ action: string; target: string }>(input)
    expect(result.action).toBe('delegate')
    expect(result.target).toBe('agent1')
  })

  it('should extract JSON from code fence without json label', () => {
    const input = `
Result:
\`\`\`
{"status": "ok"}
\`\`\`
`
    const result = parseJSON<{ status: string }>(input)
    expect(result.status).toBe('ok')
  })

  it('should extract JSON object from text', () => {
    const input = 'The decision is {"action": "self", "message": "Processing"} and done.'
    const result = parseJSON<{ action: string; message: string }>(input)
    expect(result.action).toBe('self')
    expect(result.message).toBe('Processing')
  })

  it('should extract JSON array from text', () => {
    const input = 'The tasks are [{"id": 1, "name": "task1"}, {"id": 2, "name": "task2"}] here.'
    const result = parseJSON<{ id: number; name: string }[]>(input)
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('task1')
  })

  it('should throw on invalid JSON', () => {
    expect(() => parseJSON('not json at all')).toThrow(/Failed to parse JSON/)
  })

  it('should throw on malformed JSON in code fence', () => {
    const input = `
\`\`\`json
{broken: json}
\`\`\`
`
    expect(() => parseJSON(input)).toThrow(/Failed to parse JSON/)
  })

  it('should handle nested JSON objects', () => {
    const input = '{"outer": {"inner": {"value": 42}}}'
    const result = parseJSON<{ outer: { inner: { value: number } } }>(input)
    expect(result.outer.inner.value).toBe(42)
  })

  it('should handle JSON with special characters', () => {
    const input = '{"message": "Hello\\nWorld\\t!"}'
    const result = parseJSON<{ message: string }>(input)
    expect(result.message).toBe('Hello\nWorld\t!')
  })

  it('should handle empty object', () => {
    const result = parseJSON<{}>('{}')
    expect(result).toEqual({})
  })

  it('should handle empty array', () => {
    const result = parseJSON<any[]>('[]')
    expect(result).toEqual([])
  })

  it('should handle JSON with unicode', () => {
    const input = '{"name": "中文测试", "emoji": "🎉"}'
    const result = parseJSON<{ name: string; emoji: string }>(input)
    expect(result.name).toBe('中文测试')
    expect(result.emoji).toBe('🎉')
  })

  it('should handle multiple code fences and use first valid one', () => {
    const input = `
First block:
\`\`\`json
{"value": 1}
\`\`\`
Second block:
\`\`\`json
{"value": 2}
\`\`\`
`
    const result = parseJSON<{ value: number }>(input)
    // Should use first code fence
    expect(result.value).toBe(1)
  })

  it('should handle JSON with null values', () => {
    const input = '{"name": null, "value": 42}'
    const result = parseJSON<{ name: null; value: number }>(input)
    expect(result.name).toBeNull()
    expect(result.value).toBe(42)
  })

  it('should handle JSON with boolean values', () => {
    const input = '{"active": true, "disabled": false}'
    const result = parseJSON<{ active: boolean; disabled: boolean }>(input)
    expect(result.active).toBe(true)
    expect(result.disabled).toBe(false)
  })

  it('should truncate error message to 200 characters', () => {
    const longInput = 'a'.repeat(500) + ' not json'
    try {
      parseJSON(longInput)
    } catch (e) {
      expect((e as Error).message.length).toBeLessThan(300) // "Failed to parse JSON from: " + 200 chars
    }
  })

  it('should throw when requiredKeys are missing', () => {
    expect(() => parseJSON('{}', ['action', 'message', 'reason'])).toThrow(/Missing required field/)
  })

  it('should throw when some requiredKeys are missing', () => {
    expect(() => parseJSON('{"action": "self"}', ['action', 'message'])).toThrow(/Missing required field: message/)
  })

  it('should pass when all requiredKeys are present', () => {
    const result = parseJSON<{ action: string; message: string; reason: string }>(
      '{"action": "self", "message": "ok", "reason": "闲聊"}',
      ['action', 'message', 'reason']
    )
    expect(result.action).toBe('self')
    expect(result.message).toBe('ok')
    expect(result.reason).toBe('闲聊')
  })

  it('should not validate requiredKeys when not provided', () => {
    const result = parseJSON<{}>('{}')
    expect(result).toEqual({})
  })
})
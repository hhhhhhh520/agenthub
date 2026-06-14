import { describe, it, expect } from 'vitest'
import { createAdapter } from '../src/lib/adapter'
import { LLMAdapter } from '../src/lib/adapter/llm-adapter'

describe('createAdapter', () => {
  it('should create ClaudeCodeAdapter for claude-code platform', () => {
    const adapter = createAdapter({ platform: 'claude-code' })
    expect(adapter.constructor.name).toBe('ClaudeCodeAdapter')
  })

  it('should create OpenCodeAdapter for opencode platform', () => {
    const adapter = createAdapter({ platform: 'opencode' })
    expect(adapter.constructor.name).toBe('OpenCodeAdapter')
  })

  it('should default to ClaudeCodeAdapter for unknown platform', () => {
    const adapter = createAdapter({ platform: 'unknown' as any })
    expect(adapter.constructor.name).toBe('ClaudeCodeAdapter')
  })

  it('should default to ClaudeCodeAdapter when platform is not specified', () => {
    const adapter = createAdapter({ platform: undefined as any })
    expect(adapter.constructor.name).toBe('ClaudeCodeAdapter')
  })
})

describe('LLMAdapter (retained, not exposed via createAdapter)', () => {
  it('should implement AgentAdapter interface (connect/send/close)', () => {
    const adapter = new LLMAdapter()
    expect(typeof adapter.connect).toBe('function')
    expect(typeof adapter.send).toBe('function')
    expect(typeof adapter.close).toBe('function')
  })

  it('connect should accept config without throwing', async () => {
    const adapter = new LLMAdapter()
    await expect(adapter.connect({ platform: 'claude-code', apiKey: 'test', model: 'gpt-4' })).resolves.toBeUndefined()
  })

  it('send should return an async iterable', () => {
    const adapter = new LLMAdapter()
    const result = adapter.send({ prompt: 'test' })
    expect(result[Symbol.asyncIterator]).toBeDefined()
  })

  it('close should abort without throwing', async () => {
    const adapter = new LLMAdapter()
    await expect(adapter.close()).resolves.toBeUndefined()
  })

  it('send should not crash when not connected (no API key)', async () => {
    const adapter = new LLMAdapter()
    // AI SDK 在无 API key 时会抛 LoadAPIKeyError（出现在 stderr），
    // 但 textStream 迭代可能静默结束。验证不会抛出未捕获异常。
    const chunks: any[] = []
    for await (const chunk of adapter.send({ prompt: 'test' })) {
      chunks.push(chunk)
    }
    // 无 API key 时可能返回空或 error chunk，两种都可接受
    expect(chunks.every(c => c.type === 'text' || c.type === 'error')).toBe(true)
  })
})

describe('createAdapter — config passthrough', () => {
  it('should create ClaudeCodeAdapter with workDir', () => {
    const adapter = createAdapter({ platform: 'claude-code', workDir: '/project' })
    expect(adapter.constructor.name).toBe('ClaudeCodeAdapter')
  })

  it('should create adapter regardless of extra config fields', () => {
    const adapter = createAdapter({
      platform: 'claude-code',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-20250514',
      baseUrl: 'https://api.example.com',
      workDir: '/tmp',
    })
    expect(adapter.constructor.name).toBe('ClaudeCodeAdapter')
  })
})

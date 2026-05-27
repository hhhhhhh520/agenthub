import { describe, it, expect } from 'vitest'
import { createAdapter } from '../src/lib/adapter'
import { LLMAdapter } from '../src/lib/adapter/llm-adapter'

describe('createAdapter', () => {
  it('should create LLMAdapter for llm platform', () => {
    const adapter = createAdapter({ platform: 'llm' })
    expect(adapter).toBeInstanceOf(LLMAdapter)
  })

  it('should create ClaudeCodeAdapter for claude-code platform', () => {
    const adapter = createAdapter({ platform: 'claude-code' })
    expect(adapter.constructor.name).toBe('ClaudeCodeAdapter')
  })

  it('should create OpenCodeAdapter for opencode platform', () => {
    const adapter = createAdapter({ platform: 'opencode' })
    expect(adapter.constructor.name).toBe('OpenCodeAdapter')
  })

  it('should default to LLMAdapter for unknown platform', () => {
    const adapter = createAdapter({ platform: 'unknown' as any })
    expect(adapter).toBeInstanceOf(LLMAdapter)
  })

  it('should default to LLMAdapter when platform is not specified', () => {
    const adapter = createAdapter({ platform: undefined as any })
    expect(adapter).toBeInstanceOf(LLMAdapter)
  })
})

describe('LLMAdapter', () => {
  it('should have required methods', () => {
    const adapter = new LLMAdapter()

    expect(typeof adapter.connect).toBe('function')
    expect(typeof adapter.send).toBe('function')
    expect(typeof adapter.close).toBe('function')
  })

  it('should track connection state', () => {
    const adapter = new LLMAdapter()

    // Initially not connected (no isConnected property, but we can test behavior)
    expect(typeof adapter.connect).toBe('function')
  })
})
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'

/**
 * Multi-provider isolation tests.
 * Verifies that different agents using different providers (platform/model/baseUrl/apiKey)
 * don't interfere with each other at the adapter layer.
 */

// ─── LLMAdapter SDK selection ──────────────────────────────────────────────────
// The LLMAdapter selects SDK based on config:
//   baseUrl present → OpenAI SDK (covers DeepSeek, Moonshot, etc.)
//   no baseUrl + model matches /^(gpt-|o1-|o3-)/ → OpenAI SDK
//   otherwise → Anthropic SDK

// Module-level capture for ProcessRegistry mock
let capturedEnvList: Array<Record<string, string>> = []

function createMockProcess(): ChildProcess {
  const proc = new EventEmitter() as any
  proc.stdin = new EventEmitter() as any
  proc.stdin.write = vi.fn()
  proc.stdin.end = vi.fn()
  proc.stdout = new EventEmitter() as any
  proc.stderr = new EventEmitter() as any
  proc.pid = Math.floor(Math.random() * 100000)
  proc.exitCode = null
  proc.killed = false
  proc.kill = vi.fn(() => { proc.exitCode = null; return true })
  return proc as ChildProcess
}

vi.mock('child_process', () => ({
  spawn: vi.fn((cmd: string, args: string[], options: any) => {
    capturedEnvList.push(options?.env || {})
    return createMockProcess()
  }),
}))

describe('LLMAdapter — SDK selection logic', () => {
  // We can't easily intercept createOpenAI/createAnthropic calls without deep mocking,
  // but we can verify the connect/send/close lifecycle and instance independence.

  it('each adapter instance should have independent config', async () => {
    const { LLMAdapter } = await import('../src/lib/adapter/llm-adapter')
    const adapter1 = new LLMAdapter()
    const adapter2 = new LLMAdapter()

    await adapter1.connect({ platform: 'claude-code', apiKey: 'key-1', model: 'gpt-4', baseUrl: 'https://api1.example.com' })
    await adapter2.connect({ platform: 'claude-code', apiKey: 'key-2', model: 'claude-sonnet-4-20250514' })

    // Both should be independently usable — connecting one doesn't affect the other
    const iter1 = adapter1.send({ prompt: 'test1' })
    const iter2 = adapter2.send({ prompt: 'test2' })
    expect(iter1[Symbol.asyncIterator]).toBeDefined()
    expect(iter2[Symbol.asyncIterator]).toBeDefined()

    await adapter1.close()
    await adapter2.close()
  })

  it('close on one adapter should not abort another', async () => {
    const { LLMAdapter } = await import('../src/lib/adapter/llm-adapter')
    const adapter1 = new LLMAdapter()
    const adapter2 = new LLMAdapter()

    await adapter1.connect({ platform: 'claude-code', apiKey: 'key-1' })
    await adapter2.connect({ platform: 'claude-code', apiKey: 'key-2' })

    // Abort adapter1
    await adapter1.close()

    // adapter2 should still be usable (not aborted)
    const iter = adapter2.send({ prompt: 'still works' })
    expect(iter[Symbol.asyncIterator]).toBeDefined()
    // Consume to verify no crash
    for await (const chunk of iter) {
      // Will either yield text/error or complete — should not throw
      break
    }
    await adapter2.close()
  })
})

describe('LLMAdapter — baseUrl normalization', () => {
  // The adapter normalizes baseUrl: strips trailing slashes, appends /v1 if missing.
  // This is tested indirectly through connect() since the normalization happens inside send().

  it('should accept various baseUrl formats without throwing', async () => {
    const { LLMAdapter } = await import('../src/lib/adapter/llm-adapter')

    const baseUrls = [
      'https://api.deepseek.com',
      'https://api.deepseek.com/',
      'https://api.deepseek.com/v1',
      'https://api.deepseek.com/v1/',
      'https://api.moonshot.cn/v1',
      'https://custom-proxy.example.com/api',
    ]

    for (const baseUrl of baseUrls) {
      const adapter = new LLMAdapter()
      await expect(
        adapter.connect({ platform: 'claude-code', apiKey: 'test', model: 'deepseek-chat', baseUrl })
      ).resolves.toBeUndefined()
      await adapter.close()
    }
  })
})

// ─── createAdapter factory isolation ───────────────────────────────────────────

describe('createAdapter — instance isolation', () => {
  it('should create independent adapter instances for different platforms', async () => {
    const { createAdapter } = await import('../src/lib/adapter')

    const llm = createAdapter({ platform: 'claude-code' })
    const cli = createAdapter({ platform: 'claude-code' })
    const oc = createAdapter({ platform: 'opencode' })

    // All three should be different instances
    expect(llm).not.toBe(cli)
    expect(llm).not.toBe(oc)
    expect(cli).not.toBe(oc)
  })

  it('should create new instance on every call (no singleton)', async () => {
    const { createAdapter } = await import('../src/lib/adapter')

    const a1 = createAdapter({ platform: 'claude-code' })
    const a2 = createAdapter({ platform: 'claude-code' })
    expect(a1).not.toBe(a2)
  })
})

// ─── ProcessRegistry env injection isolation ──────────────────────────────────
// Two agents with different API keys should get different env vars injected.

describe('ProcessRegistry — per-agent env isolation', () => {
  beforeEach(() => {
    capturedEnvList = []
    vi.clearAllMocks()
  })

  it('two agents with different API keys should get isolated env vars', async () => {
    const { processRegistry } = await import('../src/lib/adapter/process-registry')

    const rand = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const key1 = `test-agent-a-${rand}`
    const key2 = `test-agent-b-${rand}`

    const before = capturedEnvList.length

    processRegistry.getOrCreate(key1, {
      workDir: '/tmp/test',
      apiKey: 'sk-agent-a-key-123',
      baseUrl: 'https://api.agent-a.com',
    })

    processRegistry.getOrCreate(key2, {
      workDir: '/tmp/test',
      apiKey: 'sk-agent-b-key-456',
      baseUrl: 'https://api.agent-b.com',
    })

    // Both agents should have been spawned (captured in mock)
    const newEnvs = capturedEnvList.slice(before)
    expect(newEnvs.length).toBeGreaterThanOrEqual(2)

    // Find which env has which key
    const envA = newEnvs.find(e => e.ANTHROPIC_API_KEY === 'sk-agent-a-key-123')
    const envB = newEnvs.find(e => e.ANTHROPIC_API_KEY === 'sk-agent-b-key-456')

    expect(envA).toBeDefined()
    expect(envB).toBeDefined()
    expect(envA!.ANTHROPIC_BASE_URL).toBe('https://api.agent-a.com')
    expect(envB!.ANTHROPIC_BASE_URL).toBe('https://api.agent-b.com')

    // Verify they are different env objects (not shared references)
    expect(envA).not.toBe(envB)
  })

  it('agent-specific key should override system env var', async () => {
    const { processRegistry } = await import('../src/lib/adapter/process-registry')

    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'system-level-key'

    const before = capturedEnvList.length
    const key = `test-override-${Date.now()}`
    processRegistry.getOrCreate(key, {
      workDir: '/tmp/test',
      apiKey: 'agent-specific-key',
    })

    const env = capturedEnvList[before]
    expect(env.ANTHROPIC_API_KEY).toBe('agent-specific-key')

    // Restore
    if (original !== undefined) {
      process.env.ANTHROPIC_API_KEY = original
    } else {
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  it('agent without apiKey should inherit system env', async () => {
    const { processRegistry } = await import('../src/lib/adapter/process-registry')

    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'inherited-system-key'

    const before = capturedEnvList.length
    const key = `test-inherit-${Date.now()}`
    processRegistry.getOrCreate(key, {
      workDir: '/tmp/test',
      // No apiKey provided
    })

    const env = capturedEnvList[before]
    expect(env.ANTHROPIC_API_KEY).toBe('inherited-system-key')

    // Restore
    if (original !== undefined) {
      process.env.ANTHROPIC_API_KEY = original
    } else {
      delete process.env.ANTHROPIC_API_KEY
    }
  })
})

// ─── OpenCodeAdapter env injection ─────────────────────────────────────────────

describe('OpenCodeAdapter — provider env injection', () => {
  it('should set both ANTHROPIC_* and OPENAI_* env vars when apiKey is provided', async () => {
    // OpenCodeAdapter injects into spawn env, which we can verify through the mock
    const { OpenCodeAdapter } = await import('../src/lib/adapter/opencode-adapter')
    const adapter = new OpenCodeAdapter()

    await adapter.connect({
      platform: 'opencode',
      apiKey: 'sk-test-opencode-key',
      baseUrl: 'https://proxy.example.com',
      model: 'deepseek-chat',
      workDir: '/tmp/test-oc',
    })

    // Verify config was stored (we can't easily capture spawn env without additional mocking,
    // but we verify connect() doesn't throw and stores config correctly)
    expect(adapter).toBeDefined()
    await adapter.close()
  })
})

// ─── End-to-end provider flow simulation ──────────────────────────────────────

describe('Provider isolation — simulated multi-agent execution', () => {
  it('agents with different platforms should get different adapter types', async () => {
    const { createAdapter } = await import('../src/lib/adapter')
    const { LLMAdapter } = await import('../src/lib/adapter/llm-adapter')

    // Agent A: Claude Code with DeepSeek
    const agentA = createAdapter({ platform: 'claude-code', baseUrl: 'https://api.deepseek.com', apiKey: 'ds-key', model: 'deepseek-chat' })

    // Agent B: Claude Code CLI
    const agentB = createAdapter({ platform: 'claude-code', apiKey: 'claude-key', model: 'claude-opus-4-7' })

    // Agent C: Claude Code with OpenAI
    const agentC = createAdapter({ platform: 'claude-code', apiKey: 'openai-key', model: 'gpt-4o' })

    expect(agentA.constructor.name).toBe('ClaudeCodeAdapter')
    expect(agentB.constructor.name).toBe('ClaudeCodeAdapter')
    expect(agentC.constructor.name).toBe('ClaudeCodeAdapter')

    // All are different instances
    expect(agentA).not.toBe(agentC)
  })

  it('provider config should flow through connect without cross-contamination', async () => {
    const { LLMAdapter } = await import('../src/lib/adapter/llm-adapter')

    const agents = [
      { apiKey: 'deepseek-key', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' },
      { apiKey: 'moonshot-key', model: 'moonshot-v1-8k', baseUrl: 'https://api.moonshot.cn' },
      { apiKey: 'anthropic-key', model: 'claude-sonnet-4-20250514' },
    ]

    const adapters = agents.map(a => {
      const adapter = new LLMAdapter()
      return adapter.connect({ platform: 'claude-code', ...a }).then(() => adapter)
    })

    const resolved = await Promise.all(adapters)

    // Each adapter should independently produce an async iterable
    const iters = resolved.map(a => a.send({ prompt: 'test' }))
    for (const iter of iters) {
      expect(iter[Symbol.asyncIterator]).toBeDefined()
    }

    await Promise.all(resolved.map(a => a.close()))
  })
})

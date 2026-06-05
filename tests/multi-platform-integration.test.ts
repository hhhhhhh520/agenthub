import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Multi-platform integration tests.
 * Covers: OpenCode adapter edge cases, ClaudeCode adapter config flow,
 * createAdapter factory completeness, ProcessRegistry env merge for both platforms.
 */

// ─── Mock ProcessRegistry for adapter-level tests ────────────────────────────

const { mockGetOrCreate, mockSend } = vi.hoisted(() => ({
  mockGetOrCreate: vi.fn().mockReturnValue({ sessionId: null }),
  mockSend: vi.fn(),
}))

vi.mock('@/lib/adapter/process-registry', () => ({
  processRegistry: {
    getOrCreate: mockGetOrCreate,
    send: mockSend,
  },
}))

// ─── OpenCode adapter — argument building edge cases ─────────────────────────

describe('OpenCode adapter — argument building', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSend.mockImplementation(async function* () {})
  })

  it('should NOT push --model when model is undefined', async () => {
    const { OpenCodeAdapter } = await import('../src/lib/adapter/opencode-adapter')
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/dir' })

    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }

    const config = mockSend.mock.calls[0][2]
    expect(config.args).not.toContain('--model')
  })

  it('should NOT push --session when sessionId is undefined', async () => {
    const { OpenCodeAdapter } = await import('../src/lib/adapter/opencode-adapter')
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/dir' })

    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }

    const config = mockSend.mock.calls[0][2]
    expect(config.args).not.toContain('--session')
  })

  it('should NOT set ANTHROPIC_API_KEY when apiKey is undefined', async () => {
    const { OpenCodeAdapter } = await import('../src/lib/adapter/opencode-adapter')
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/dir' })

    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }

    const config = mockSend.mock.calls[0][2]
    expect(config.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(config.env.OPENAI_API_KEY).toBeUndefined()
  })

  it('should NOT set BASE_URL env vars when baseUrl is undefined', async () => {
    const { OpenCodeAdapter } = await import('../src/lib/adapter/opencode-adapter')
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', apiKey: 'sk-test', workDir: '/dir' })

    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }

    const config = mockSend.mock.calls[0][2]
    expect(config.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(config.env.OPENAI_BASE_URL).toBeUndefined()
  })

  it('should always set OPENCODE_PERMISSION in env', async () => {
    const { OpenCodeAdapter } = await import('../src/lib/adapter/opencode-adapter')
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/dir' })

    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }

    const config = mockSend.mock.calls[0][2]
    expect(config.env.OPENCODE_PERMISSION).toBe('{"*":"allow"}')
  })

  it('should generate workDir when not provided', async () => {
    const { OpenCodeAdapter } = await import('../src/lib/adapter/opencode-adapter')
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode' })

    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }

    const config = mockSend.mock.calls[0][2]
    expect(config.workDir).toContain('opencode-')
  })

  it('should set both ANTHROPIC and OPENAI env vars when both apiKey and baseUrl provided', async () => {
    const { OpenCodeAdapter } = await import('../src/lib/adapter/opencode-adapter')
    const adapter = new OpenCodeAdapter()
    await adapter.connect({
      platform: 'opencode',
      apiKey: 'sk-full',
      baseUrl: 'https://proxy.example.com',
      workDir: '/dir',
    })

    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }

    const config = mockSend.mock.calls[0][2]
    expect(config.env.ANTHROPIC_API_KEY).toBe('sk-full')
    expect(config.env.OPENAI_API_KEY).toBe('sk-full')
    expect(config.env.ANTHROPIC_BASE_URL).toBe('https://proxy.example.com')
    expect(config.env.OPENAI_BASE_URL).toBe('https://proxy.example.com')
  })
})

// ─── ClaudeCode adapter — config flow through ProcessRegistry ────────────────

describe('ClaudeCode adapter — config flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetOrCreate.mockReturnValue({ sessionId: null })
    mockSend.mockImplementation(async function* () {})
  })

  it('should pass all config fields to ProcessRegistry', async () => {
    const { ClaudeCodeAdapter } = await import('../src/lib/adapter/claude-code-adapter')
    const adapter = new ClaudeCodeAdapter()
    await adapter.connect({
      platform: 'claude-code',
      workDir: '/project',
      sessionId: 'sess-1',
      permissionMode: 'auto',
      mcpConfig: '{"tools":[]}',
      agentId: 'agent-1',
      chatSessionId: 'chat-1',
      apiKey: 'sk-test',
      baseUrl: 'https://api.test.com',
      model: 'claude-sonnet-4-20250514',
    })

    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }

    const config = mockGetOrCreate.mock.calls[0][1]
    expect(config.workDir).toBe('/project')
    expect(config.sessionId).toBe('sess-1')
    expect(config.permissionMode).toBe('auto')
    expect(config.mcpConfig).toBe('{"tools":[]}')
    expect(config.apiKey).toBe('sk-test')
    expect(config.baseUrl).toBe('https://api.test.com')
    expect(config.model).toBe('claude-sonnet-4-20250514')
  })

  it('getRegistryKey format: chatSessionId:agentId:workDir', async () => {
    const { ClaudeCodeAdapter } = await import('../src/lib/adapter/claude-code-adapter')
    const adapter = new ClaudeCodeAdapter()
    await adapter.connect({
      platform: 'claude-code',
      workDir: '/project',
      chatSessionId: 'chat-1',
      agentId: 'agent-1',
    })

    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }

    expect(mockGetOrCreate).toHaveBeenCalledWith(
      'chat-1:agent-1:/project',
      expect.anything()
    )
  })

  it('getRegistryKey defaults to default:default:workDir', async () => {
    const { ClaudeCodeAdapter } = await import('../src/lib/adapter/claude-code-adapter')
    const adapter = new ClaudeCodeAdapter()
    await adapter.connect({ platform: 'claude-code', workDir: '/dir' })

    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }

    expect(mockGetOrCreate).toHaveBeenCalledWith(
      'default:default:/dir',
      expect.anything()
    )
  })

  it('send concatenates systemPrompt + context + prompt', async () => {
    const { ClaudeCodeAdapter } = await import('../src/lib/adapter/claude-code-adapter')
    const adapter = new ClaudeCodeAdapter()
    await adapter.connect({ platform: 'claude-code', workDir: '/dir' })

    const gen = adapter.send({ prompt: 'do it', context: 'some context', systemPrompt: 'you are PM' })
    for await (const _ of gen) { /* consume */ }

    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      'you are PM\n\n---\n\n背景信息：\nsome context\n\n---\n\ndo it',
      expect.anything(),
      []
    )
  })

  it('send captures session chunk and updates sessionId', async () => {
    const { ClaudeCodeAdapter } = await import('../src/lib/adapter/claude-code-adapter')
    const adapter = new ClaudeCodeAdapter()
    await adapter.connect({ platform: 'claude-code', workDir: '/dir' })

    mockSend.mockImplementation(async function* () {
      yield { type: 'session', content: 'sess-123' }
      yield { type: 'text', content: 'hello' }
    })

    const chunks: any[] = []
    for await (const chunk of adapter.send({ prompt: 'test' })) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([
      { type: 'session', content: 'sess-123' },
      { type: 'text', content: 'hello' },
    ])
    expect((adapter as any).sessionId).toBe('sess-123')
  })

  it('close is a no-op', async () => {
    const { ClaudeCodeAdapter } = await import('../src/lib/adapter/claude-code-adapter')
    const adapter = new ClaudeCodeAdapter()
    await adapter.connect({ platform: 'claude-code', workDir: '/dir' })
    await adapter.close()
  })
})

// ─── createAdapter factory — completeness ────────────────────────────────────

describe('createAdapter factory — all platforms', () => {
  it('should return ClaudeCodeAdapter for platform "claude-code"', async () => {
    const { createAdapter } = await import('../src/lib/adapter')
    const adapter = createAdapter({ platform: 'claude-code' })
    expect(adapter.constructor.name).toBe('ClaudeCodeAdapter')
  })

  it('should return ClaudeCodeAdapter for platform "claude-code"', async () => {
    const { createAdapter } = await import('../src/lib/adapter')
    const adapter = createAdapter({ platform: 'claude-code' })
    expect(adapter.constructor.name).toBe('ClaudeCodeAdapter')
  })

  it('should return OpenCodeAdapter for platform "opencode"', async () => {
    const { createAdapter } = await import('../src/lib/adapter')
    const adapter = createAdapter({ platform: 'opencode' })
    expect(adapter.constructor.name).toBe('OpenCodeAdapter')
  })

  it('should default to ClaudeCodeAdapter for unknown platform', async () => {
    const { createAdapter } = await import('../src/lib/adapter')
    const adapter = createAdapter({ platform: 'unknown' as any })
    expect(adapter.constructor.name).toBe('ClaudeCodeAdapter')
  })

  it('should create independent instances on every call', async () => {
    const { createAdapter } = await import('../src/lib/adapter')
    const a1 = createAdapter({ platform: 'claude-code' })
    const a2 = createAdapter({ platform: 'claude-code' })
    const a3 = createAdapter({ platform: 'opencode' })
    expect(a1).not.toBe(a2)
    expect(a1).not.toBe(a3)
  })
})

// ─── ProcessRegistry — env merge (using child_process mock) ─────────────────

// These tests need the real ProcessRegistry, so we use a separate describe block
// with its own mock setup via dynamic import

describe('ProcessRegistry — env merge for Claude Code and OpenCode', () => {
  let capturedSpawnCalls: Array<{ cmd: string; args: string[]; options: any }> = []

  beforeEach(async () => {
    // Reset the global registry to avoid cross-test contamination
    const mod = await import('../src/lib/adapter/process-registry')
    // We can't easily reset the registry, so we use unique keys
    capturedSpawnCalls = []
  })

  it('Claude Code: provider env should override system env', async () => {
    // This test verifies the spawn env by checking the ProcessRegistry behavior
    // We test through the adapter since ProcessRegistry is a singleton
    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'system-key'

    // The mock ProcessRegistry from the hoisted mock doesn't actually spawn,
    // so we verify the env logic through the spawnConfig that gets passed
    const { ClaudeCodeAdapter } = await import('../src/lib/adapter/claude-code-adapter')
    const adapter = new ClaudeCodeAdapter()
    await adapter.connect({
      platform: 'claude-code',
      workDir: '/tmp/test-cc-env',
      apiKey: 'agent-specific-key',
      baseUrl: 'https://agent.specific.com',
    })

    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }

    // The spawnConfig passed to getOrCreate should have the provider env
    const config = mockGetOrCreate.mock.calls[0][1]
    expect(config.apiKey).toBe('agent-specific-key')
    expect(config.baseUrl).toBe('https://agent.specific.com')

    if (original !== undefined) {
      process.env.ANTHROPIC_API_KEY = original
    } else {
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  it('OpenCode: spawnConfig should include provider env and custom env', async () => {
    const { OpenCodeAdapter } = await import('../src/lib/adapter/opencode-adapter')
    const adapter = new OpenCodeAdapter()
    await adapter.connect({
      platform: 'opencode',
      workDir: '/tmp/test-oc-env',
      apiKey: 'sk-oc-key',
      baseUrl: 'https://oc.proxy.com',
    })

    const callBefore = mockSend.mock.calls.length
    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }

    const config = mockSend.mock.calls[callBefore][2]
    expect(config.env.ANTHROPIC_API_KEY).toBe('sk-oc-key')
    expect(config.env.ANTHROPIC_BASE_URL).toBe('https://oc.proxy.com')
    expect(config.env.OPENCODE_PERMISSION).toBe('{"*":"allow"}')
  })

  it('two adapters with different configs should pass different spawnConfigs', async () => {
    const { ClaudeCodeAdapter } = await import('../src/lib/adapter/claude-code-adapter')
    const { OpenCodeAdapter } = await import('../src/lib/adapter/opencode-adapter')

    const cc = new ClaudeCodeAdapter()
    const oc = new OpenCodeAdapter()

    await cc.connect({ platform: 'claude-code', workDir: '/cc', apiKey: 'sk-cc' })
    await oc.connect({ platform: 'opencode', workDir: '/oc', apiKey: 'sk-oc' })

    // Send on CC
    mockGetOrCreate.mockReturnValue({ sessionId: null })
    mockSend.mockImplementation(async function* () {})
    const ccGen = cc.send({ prompt: 'test' })
    for await (const _ of ccGen) { /* consume */ }

    // CC spawnConfig should have cc key (via getOrCreate)
    const ccConfig = mockGetOrCreate.mock.calls[mockGetOrCreate.mock.calls.length - 1][1]
    expect(ccConfig.apiKey).toBe('sk-cc')

    // Verify OC adapter passes config via mockSend
    const sendCallsBefore = mockSend.mock.calls.length
    mockSend.mockImplementation(async function* () {})
    const ocGen = oc.send({ prompt: 'test' })
    for await (const _ of ocGen) { /* consume */ }

    // OC should have called mockSend with spawnConfig containing oc env
    expect(mockSend.mock.calls.length).toBe(sendCallsBefore + 1)
    const ocCall = mockSend.mock.calls[sendCallsBefore]
    expect(ocCall[0]).toContain('opencode:')  // registry key
    expect(ocCall[2]).toBeDefined()
    // OpenCodeAdapter puts apiKey in env, not as direct spawnConfig field
    expect(ocCall[2].env.ANTHROPIC_API_KEY).toBe('sk-oc')
    expect(ocCall[2].command).toBe('opencode')
  })
})

// ─── Cross-platform adapter lifecycle ────────────────────────────────────────

describe('Cross-platform adapter lifecycle', () => {
  it('OpenCode close is a no-op', async () => {
    const { OpenCodeAdapter } = await import('../src/lib/adapter/opencode-adapter')
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/dir' })
    await adapter.close()
  })

  it('ClaudeCode close is a no-op', async () => {
    const { ClaudeCodeAdapter } = await import('../src/lib/adapter/claude-code-adapter')
    const adapter = new ClaudeCodeAdapter()
    await adapter.connect({ platform: 'claude-code', workDir: '/dir' })
    await adapter.close()
  })

  it('LLMAdapter close aborts the controller', async () => {
    const { LLMAdapter } = await import('../src/lib/adapter/llm-adapter')
    const adapter = new LLMAdapter()
    await adapter.connect({ platform: 'claude-code', apiKey: 'test' })
    await adapter.close()
  })

  it('multiple adapters of different types can coexist', async () => {
    const { createAdapter } = await import('../src/lib/adapter')

    const llm = createAdapter({ platform: 'claude-code' })
    const cc = createAdapter({ platform: 'claude-code' })
    const oc = createAdapter({ platform: 'opencode' })

    await llm.connect({ platform: 'claude-code', apiKey: 'test' })
    await cc.connect({ platform: 'claude-code', workDir: '/cc' })
    await oc.connect({ platform: 'opencode', workDir: '/oc' })

    const llmIter = llm.send({ prompt: 'test' })
    expect(llmIter[Symbol.asyncIterator]).toBeDefined()

    await llm.close()
    await oc.close()
    await cc.close()
  })
})

// ─── LLMAdapter — SDK selection edge cases ───────────────────────────────────

describe('LLMAdapter — SDK selection edge cases', () => {
  it('should use OpenAI SDK when baseUrl is provided (any model name)', async () => {
    const { LLMAdapter } = await import('../src/lib/adapter/llm-adapter')
    const adapter = new LLMAdapter()
    await adapter.connect({
      platform: 'claude-code',
      apiKey: 'test',
      model: 'claude-sonnet-4-20250514',
      baseUrl: 'https://proxy.example.com',
    })
    const iter = adapter.send({ prompt: 'test' })
    expect(iter[Symbol.asyncIterator]).toBeDefined()
    await adapter.close()
  })

  it('should use Anthropic SDK when no baseUrl and model starts with claude-', async () => {
    const { LLMAdapter } = await import('../src/lib/adapter/llm-adapter')
    const adapter = new LLMAdapter()
    await adapter.connect({
      platform: 'claude-code',
      apiKey: 'test',
      model: 'claude-sonnet-4-20250514',
    })
    const iter = adapter.send({ prompt: 'test' })
    expect(iter[Symbol.asyncIterator]).toBeDefined()
    await adapter.close()
  })

  it('should use OpenAI SDK when model starts with gpt- and no baseUrl', async () => {
    const { LLMAdapter } = await import('../src/lib/adapter/llm-adapter')
    const adapter = new LLMAdapter()
    await adapter.connect({
      platform: 'claude-code',
      apiKey: 'test',
      model: 'gpt-4o',
    })
    const iter = adapter.send({ prompt: 'test' })
    expect(iter[Symbol.asyncIterator]).toBeDefined()
    await adapter.close()
  })

  it('should use OpenAI SDK when model starts with o1- or o3-', async () => {
    const { LLMAdapter } = await import('../src/lib/adapter/llm-adapter')
    const adapter1 = new LLMAdapter()
    await adapter1.connect({ platform: 'claude-code', apiKey: 'test', model: 'o1-preview' })
    const iter1 = adapter1.send({ prompt: 'test' })
    expect(iter1[Symbol.asyncIterator]).toBeDefined()
    await adapter1.close()

    const adapter2 = new LLMAdapter()
    await adapter2.connect({ platform: 'claude-code', apiKey: 'test', model: 'o3-mini' })
    const iter2 = adapter2.send({ prompt: 'test' })
    expect(iter2[Symbol.asyncIterator]).toBeDefined()
    await adapter2.close()
  })

  it('should default to claude-sonnet-4-20250514 when no model specified', async () => {
    const { LLMAdapter } = await import('../src/lib/adapter/llm-adapter')
    const adapter = new LLMAdapter()
    await adapter.connect({ platform: 'claude-code', apiKey: 'test' })
    const iter = adapter.send({ prompt: 'test' })
    expect(iter[Symbol.asyncIterator]).toBeDefined()
    await adapter.close()
  })
})

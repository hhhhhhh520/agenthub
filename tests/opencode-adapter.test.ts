import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mock setup ---
const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}))

vi.mock('@/lib/adapter/process-registry', () => ({
  processRegistry: {
    send: mockSend,
  },
}))

import { OpenCodeAdapter } from '@/lib/adapter/opencode-adapter'

beforeEach(() => {
  vi.clearAllMocks()
  mockSend.mockImplementation(async function* () {})
})

describe('OpenCodeAdapter', () => {
  it('connect stores config and workDir', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/project' })
    // Verify via send which passes spawnConfig to processRegistry
    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }
    const config = mockSend.mock.calls[0][2]
    expect(config.workDir).toBe('/project')
    expect(config.command).toBe('opencode')
    expect(config.format).toBe('ndjson')
  })

  it('connect stores sessionId, agentId, chatSessionId', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({
      platform: 'opencode',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      chatSessionId: 'chat-1',
    })
    expect(adapter.getSessionId()).toBe('sess-1')
  })

  it('getRegistryKey format: opencode:chatSessionId:agentId:workDir', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({
      platform: 'opencode',
      workDir: '/project',
      chatSessionId: 'chat-1',
      agentId: 'agent-1',
    })
    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }
    expect(mockSend).toHaveBeenCalledWith(
      'opencode:chat-1:agent-1:/project',
      expect.anything(),
      expect.anything()
    )
  })

  it('getRegistryKey defaults to opencode:default:default:workDir', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/dir' })
    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }
    expect(mockSend).toHaveBeenCalledWith(
      'opencode:default:default:/dir',
      expect.anything(),
      expect.anything()
    )
  })

  it('send builds correct args with model, systemPrompt, session', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', model: 'claude-3', sessionId: 's1', workDir: '/dir' })
    const gen = adapter.send({ prompt: 'hi', systemPrompt: 'you are PM' })
    for await (const _ of gen) { /* consume */ }
    const config = mockSend.mock.calls[0][2]
    expect(config.args).toContain('--model')
    expect(config.args).toContain('claude-3')
    expect(config.args).toContain('--prompt')
    expect(config.args).toContain('you are PM')
    expect(config.args).toContain('--session')
    expect(config.args).toContain('s1')
  })

  it('send prepends context to prompt', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/dir' })
    const gen = adapter.send({ prompt: 'do it', context: 'background info' })
    for await (const _ of gen) { /* consume */ }
    const prompt = mockSend.mock.calls[0][1]
    expect(prompt).toContain('Context:')
    expect(prompt).toContain('background info')
    expect(prompt).toContain('do it')
  })

  it('send sets OPENCODE_PERMISSION in env', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/dir' })
    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }
    const config = mockSend.mock.calls[0][2]
    expect(config.env.OPENCODE_PERMISSION).toBe('{"*":"allow"}')
  })

  it('send sets ANTHROPIC_API_KEY and OPENAI_API_KEY in env', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', apiKey: 'sk-123', workDir: '/dir' })
    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }
    const config = mockSend.mock.calls[0][2]
    expect(config.env.ANTHROPIC_API_KEY).toBe('sk-123')
    expect(config.env.OPENAI_API_KEY).toBe('sk-123')
  })

  it('send sets ANTHROPIC_BASE_URL and OPENAI_BASE_URL in env', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', baseUrl: 'https://api.test.com', workDir: '/dir' })
    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }
    const config = mockSend.mock.calls[0][2]
    expect(config.env.ANTHROPIC_BASE_URL).toBe('https://api.test.com')
    expect(config.env.OPENAI_BASE_URL).toBe('https://api.test.com')
  })

  it('send passes attachment file references in prompt', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/dir' })
    const gen = adapter.send({
      prompt: 'describe this',
      attachments: [
        { id: 'a1', filename: 'test.png', path: '/uploads/test.png', mimeType: 'image/png', size: 100 },
      ],
    })
    for await (const _ of gen) { /* consume */ }
    const prompt = mockSend.mock.calls[0][1]
    expect(prompt).toContain('用户附带了以下文件')
    expect(prompt).toContain('test.png')
    expect(prompt).toContain('/uploads/test.png')
  })

  it('send captures session chunk and updates sessionId', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/dir' })
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
    expect(adapter.getSessionId()).toBe('sess-123')
  })

  it('close is a no-op', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/dir' })
    await adapter.close()
    // No kill calls should be made
    expect(true).toBe(true)
  })
})

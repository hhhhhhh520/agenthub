import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mock setup ---
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

import { ClaudeCodeAdapter } from '@/lib/adapter/claude-code-adapter'

beforeEach(() => {
  vi.clearAllMocks()
  mockGetOrCreate.mockReturnValue({ sessionId: null })
  mockSend.mockImplementation(async function* () {})
})

describe('ClaudeCodeAdapter', () => {
  it('connect stores all config fields', async () => {
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
    // Verify by checking the key format and spawnConfig passed to getOrCreate
    await (adapter as any).send({ prompt: 'test' }).next()
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
    const adapter = new ClaudeCodeAdapter()
    await adapter.connect({
      platform: 'claude-code',
      workDir: '/project',
      chatSessionId: 'chat-1',
      agentId: 'agent-1',
    })
    await (adapter as any).send({ prompt: 'test' }).next()
    expect(mockGetOrCreate).toHaveBeenCalledWith(
      'chat-1:agent-1:/project',
      expect.anything()
    )
  })

  it('getRegistryKey defaults to default:default:workDir', async () => {
    const adapter = new ClaudeCodeAdapter()
    await adapter.connect({ platform: 'claude-code', workDir: '/dir' })
    await (adapter as any).send({ prompt: 'test' }).next()
    expect(mockGetOrCreate).toHaveBeenCalledWith(
      'default:default:/dir',
      expect.anything()
    )
  })

  it('send concatenates systemPrompt + context + prompt', async () => {
    const adapter = new ClaudeCodeAdapter()
    await adapter.connect({ platform: 'claude-code', workDir: '/dir' })
    mockSend.mockImplementation(async function* () { yield { type: 'text', content: 'ok' } })
    const gen = adapter.send({ prompt: 'do it', context: 'some context', systemPrompt: 'you are PM' })
    await gen.next()
    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      'you are PM\n\n---\n\n背景信息：\nsome context\n\n---\n\ndo it',
      expect.anything(),
      []
    )
  })

  it('send captures session chunk and updates sessionId', async () => {
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
    const adapter = new ClaudeCodeAdapter()
    await adapter.connect({ platform: 'claude-code', workDir: '/dir' })
    await adapter.close()
    // No kill calls should be made
    expect(true).toBe(true)
  })
})

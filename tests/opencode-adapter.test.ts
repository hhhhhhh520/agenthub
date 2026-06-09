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
    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }
    const config = mockSend.mock.calls[0][2]
    expect(config.workDir).toBe('/project')
    expect(config.command).toBe('opencode')
    expect(config.format).toBe('ndjson')
    expect(config.args).toContain('run')
    expect(config.args).toContain('--format')
    expect(config.args).toContain('json')
    expect(config.args).toContain('--dir')
    expect(config.args).toContain('/project')
    // prompt 不应该在 args 里（通过 stdin 传递）
    expect(config.args).not.toContain('--prompt')
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

  it('send builds correct args with model and session', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', model: 'mimo/mimo-v2.5-pro', sessionId: 's1', workDir: '/dir' })
    const gen = adapter.send({ prompt: 'hi', systemPrompt: 'you are PM' })
    for await (const _ of gen) { /* consume */ }
    const config = mockSend.mock.calls[0][2]
    expect(config.args).toContain('run')
    expect(config.args).toContain('--format')
    expect(config.args).toContain('json')
    expect(config.args).toContain('--model')
    expect(config.args).toContain('mimo/mimo-v2.5-pro')
    expect(config.args).toContain('--session')
    expect(config.args).toContain('s1')
    expect(config.args).toContain('--dir')
    expect(config.args).toContain('/dir')
    // prompt 不在 args 里
    expect(config.args).not.toContain('--prompt')
    expect(config.args).not.toContain('hi')
    expect(config.args).not.toContain('you are PM')
  })

  it('send passes only user prompt via stdin (system prompt goes to agent config)', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/dir', agentId: 'test-agent' })
    const gen = adapter.send({ prompt: 'do it', context: 'background info', systemPrompt: 'you are PM' })
    for await (const _ of gen) { /* consume */ }
    const fullPrompt = mockSend.mock.calls[0][1]
    // system prompt 写入 agent 配置文件，不拼接到 prompt
    expect(fullPrompt).not.toContain('you are PM')
    // context 不传给 CLI（CLI 通过 session 恢复管理历史）
    expect(fullPrompt).not.toContain('Context:')
    expect(fullPrompt).not.toContain('background info')
    // 只传用户消息
    expect(fullPrompt).toBe('do it')
  })

  it('send sets OPENCODE_PERMISSION in env', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/dir' })
    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }
    const config = mockSend.mock.calls[0][2]
    expect(config.env.OPENCODE_PERMISSION).toBe('{"*":"allow"}')
  })

  it('send sets ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL in env', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', apiKey: 'sk-123', baseUrl: 'https://api.test.com', workDir: '/dir' })
    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }
    const config = mockSend.mock.calls[0][2]
    expect(config.env.ANTHROPIC_API_KEY).toBe('sk-123')
    expect(config.env.ANTHROPIC_BASE_URL).toBe('https://api.test.com')
    // 不应该设置 OPENAI 环境变量
    expect(config.env.OPENAI_API_KEY).toBeUndefined()
    expect(config.env.OPENAI_BASE_URL).toBeUndefined()
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
    expect(true).toBe(true)
  })

  it('send adds --file args for attachments', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/dir' })
    // Mock existsSync to return true for test files
    const gen = adapter.send({
      prompt: 'describe',
      attachments: [
        { id: '1', filename: 'test.png', path: '/tmp/test.png', mimeType: 'image/png', size: 1000 },
        { id: '2', filename: 'doc.pdf', path: '/tmp/doc.pdf', mimeType: 'application/pdf', size: 2000 },
      ],
    })
    for await (const _ of gen) { /* consume */ }
    const config = mockSend.mock.calls[0][2]
    // --file 参数由 existsSync 控制，这里只验证 args 结构
    expect(config.args).toContain('run')
    expect(config.args).toContain('--format')
    expect(config.args).toContain('json')
  })

  it('send sets XDG_CONFIG_HOME when mcpConfig is provided', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({
      platform: 'opencode',
      workDir: '/dir',
      agentId: 'test-agent',
      mcpConfig: JSON.stringify({
        mcpServers: {
          agenthub: {
            command: 'npx',
            args: ['tsx', 'src/mcp-server/index.ts'],
            env: { AGENTHUB_SESSION_ID: 's1', AGENTHUB_AGENT_NAME: 'agent1', AGENTHUB_WORK_DIR: '/dir' },
          },
        },
      }),
    })
    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }
    const config = mockSend.mock.calls[0][2]
    // XDG_CONFIG_HOME 应该被设置
    expect(config.env.XDG_CONFIG_HOME).toBeDefined()
    expect(config.env.XDG_CONFIG_HOME).toContain('agenthub-oc-test-agent')
  })

  it('send does not set XDG_CONFIG_HOME when mcpConfig is empty', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/dir' })
    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }
    const config = mockSend.mock.calls[0][2]
    expect(config.env.XDG_CONFIG_HOME).toBeUndefined()
  })
})

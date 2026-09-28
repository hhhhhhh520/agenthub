import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

let cfgRoot = ''
beforeEach(() => {
  vi.clearAllMocks()
  mockGetOrCreate.mockReturnValue({ sessionId: null })
  mockSend.mockImplementation(async function* () {})
  // ISSUE-027：受管配置目录写入重定向到临时根，防测试污染真实 ~/.agenthub
  cfgRoot = mkdtempSync(join(tmpdir(), 'ah-adapter-cfg-'))
  process.env.AGENTHUB_CLAUDE_CFG_ROOT = cfgRoot
})

afterEach(() => {
  delete process.env.AGENTHUB_CLAUDE_CFG_ROOT
  try { rmSync(cfgRoot, { recursive: true, force: true }) } catch { /* best-effort */ }
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

  it('send concatenates systemPrompt + prompt (no context — CLI manages history)', async () => {
    const adapter = new ClaudeCodeAdapter()
    await adapter.connect({ platform: 'claude-code', workDir: '/dir' })
    mockSend.mockImplementation(async function* () { yield { type: 'text', content: 'ok' } })
    const gen = adapter.send({ prompt: 'do it', context: 'some context', systemPrompt: 'you are PM' })
    await gen.next()
    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      'you are PM\n\n---\n\ndo it',
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

  it('close is a no-op — does not call registry methods', async () => {
    const adapter = new ClaudeCodeAdapter()
    await adapter.connect({ platform: 'claude-code', workDir: '/dir' })
    vi.clearAllMocks() // 清除 connect 期间的调用记录
    await adapter.close()
    // close() 是 no-op，不应该调用任何 registry 方法
    expect(mockGetOrCreate).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  // ── ISSUE-027：provider 配置走受管 CLAUDE_CONFIG_DIR settings.json 通道 ──
  it('有 apiKey+baseUrl → spawnConfig 携带 CLAUDE_CONFIG_DIR + envScrub，settings.json 实际落盘', async () => {
    const adapter = new ClaudeCodeAdapter()
    await adapter.connect({
      platform: 'claude-code',
      workDir: '/project',
      apiKey: 'sk-test',
      baseUrl: 'https://api.test.com',
      model: 'mimo-v2.6-flash',
    })
    await (adapter as any).send({ prompt: 'test' }).next()
    const config = mockGetOrCreate.mock.calls[0][1]
    expect(config.env!.CLAUDE_CONFIG_DIR).toBeTruthy()
    expect(config.env!.CLAUDE_CONFIG_DIR).toContain(cfgRoot)
    expect(config.envScrub).toEqual({
      prefixes: ['ANTHROPIC_', 'CLAUDE_'],
      exact: expect.arrayContaining(['CLAUDECODE', 'CLAUDE_CODE_MESSAGING_SOCKET']),
    })
    // settings.json 真实写到了受管目录
    const settingsPath = join(config.env!.CLAUDE_CONFIG_DIR, 'settings.json')
    expect(existsSync(settingsPath)).toBe(true)
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe('https://api.test.com')
    expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test')
  })

  it('无 baseUrl（空配置 agent）→ 不注入 configDir，维持旧行为', async () => {
    const adapter = new ClaudeCodeAdapter()
    await adapter.connect({ platform: 'claude-code', workDir: '/dir', apiKey: 'sk-only' })
    await (adapter as any).send({ prompt: 'test' }).next()
    const config = mockGetOrCreate.mock.calls[0][1]
    expect(config.env).toBeUndefined()
    expect(config.envScrub).toBeUndefined()
  })
})

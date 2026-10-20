import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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

  it('不再使用 OPENCODE_PERMISSION env（v2.0.27 不生效）', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/dir' })
    const gen = adapter.send({ prompt: 'test' })
    for await (const _ of gen) { /* consume */ }
    const config = mockSend.mock.calls[0][2]
    expect(config.env.OPENCODE_PERMISSION).toBeUndefined()
  })

  it('auto 模式传 --auto，default 不传', async () => {
    const autoAdapter = new OpenCodeAdapter()
    await autoAdapter.connect({ platform: 'opencode', workDir: '/dir', permissionMode: 'auto' })
    for await (const _ of autoAdapter.send({ prompt: 'test' })) { /* consume */ }
    expect(mockSend.mock.calls[0][2].args).toContain('--auto')

    vi.clearAllMocks()
    mockSend.mockImplementation(async function* () {})
    const defaultAdapter = new OpenCodeAdapter()
    await defaultAdapter.connect({ platform: 'opencode', workDir: '/dir', permissionMode: 'default' })
    for await (const _ of defaultAdapter.send({ prompt: 'test' })) { /* consume */ }
    expect(mockSend.mock.calls[0][2].args).not.toContain('--auto')
  })

  it('writes tools + permission frontmatter to agent md (dual dimension)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'oc-adapter-perm-'))
    try {
      const adapter = new OpenCodeAdapter()
      await adapter.connect({
        platform: 'opencode', workDir, agentId: 'agent-perm', permissionMode: 'auto',
        allowedTools: ['Read', 'Edit', 'Bash'],
      })
      for await (const _ of adapter.send({ prompt: 'test', systemPrompt: 'sys' })) { /* consume */ }
      const cfg = mockSend.mock.calls[mockSend.mock.calls.length - 1][2]
      const agentName = cfg.args[cfg.args.indexOf('--agent') + 1] as string
      const md = readFileSync(join(workDir, '.opencode', 'agents', `${agentName}.md`), 'utf8')
      expect(md).toContain('tools:')
      expect(md).toContain('  read: true')
      expect(md).toContain('  bash: true')
      expect(md).toContain('permission:')
      expect(md).toContain('  read:')
      expect(md).toContain('    "*": allow')
      expect(md).toContain('    "*.env": ask')
      expect(md).toContain('  edit: allow')
      expect(md).toContain('  execute: allow')
      expect(md).toContain('  webfetch: deny')
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
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

  it('close is a no-op — does not call registry send', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({ platform: 'opencode', workDir: '/dir' })
    vi.clearAllMocks() // 清除 connect 期间的调用记录
    await adapter.close()
    // close() 是 no-op，不应该调用 registry.send
    expect(mockSend).not.toHaveBeenCalled()
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
    // XDG_CONFIG_HOME 应该被设置；目录名 hash 化（ISSUE-027 commit 3 审查 🟡：原始
    // agentId 含中文/路径字符会逃逸，不再出现在路径里）
    expect(config.env.XDG_CONFIG_HOME).toBeDefined()
    expect(config.env.XDG_CONFIG_HOME).toContain('agenthub-oc-')
    expect(config.env.XDG_CONFIG_HOME).not.toContain('test-agent')
  })

  it('P1-03: 同 workDir/agent 的不同会话/模式使用独立 agent 文件与 XDG 目录', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'oc-adapter-isolation-'))
    const xdgDirs = new Set<string>()
    try {
      const runAdapter = async (permissionMode: 'default' | 'auto', allowedTools: string[]) => {
        const adapter = new OpenCodeAdapter()
        await adapter.connect({
          platform: 'opencode',
          workDir,
          agentId: 'agent-isolation',
          chatSessionId: 'chat-shared',
          permissionMode,
          allowedTools,
          apiKey: 'sk-isolation',
          baseUrl: 'https://api.example.com/v1',
          model: 'deepseek-chat',
        })
        for await (const _ of adapter.send({ prompt: 'test', systemPrompt: 'sys' })) { /* consume */ }
        const cfg = mockSend.mock.calls[mockSend.mock.calls.length - 1][2]
        if (cfg.env.XDG_CONFIG_HOME) xdgDirs.add(cfg.env.XDG_CONFIG_HOME)
        return cfg
      }

      const defaultCfg = await runAdapter('default', ['Read'])
      const autoCfg = await runAdapter('auto', ['Read', 'Bash'])
      const agentNameOf = (cfg: any) => cfg.args[cfg.args.indexOf('--agent') + 1] as string
      const defaultAgent = agentNameOf(defaultCfg)
      const autoAgent = agentNameOf(autoCfg)

      expect(defaultAgent).not.toBe(autoAgent)
      expect(defaultCfg.env.XDG_CONFIG_HOME).not.toBe(autoCfg.env.XDG_CONFIG_HOME)

      const defaultPath = join(workDir, '.opencode', 'agents', `${defaultAgent}.md`)
      const autoPath = join(workDir, '.opencode', 'agents', `${autoAgent}.md`)
      expect(existsSync(defaultPath)).toBe(true)
      expect(existsSync(autoPath)).toBe(true)
      expect(existsSync(join(workDir, '.opencode', 'agents', `agenthub-agent-isolation.md`))).toBe(false)

      const defaultMd = readFileSync(defaultPath, 'utf8')
      const autoMd = readFileSync(autoPath, 'utf8')
      expect(defaultMd).toContain('  bash: false')
      expect(defaultMd).toContain('  execute: false')
      expect(defaultMd).toContain('  bash: deny')
      expect(defaultMd).toContain('  execute: deny')
      expect(autoMd).toContain('  bash: true')
      expect(autoMd).toContain('  execute: true')
      expect(autoMd).toContain('  bash: allow')
      expect(autoMd).toContain('  execute: allow')
      // auto 写入后，default 会话的权限文件不能被覆盖
      expect(readFileSync(defaultPath, 'utf8')).toContain('  bash: false')

      expect(defaultCfg.managedAgentFile).toBe(defaultPath)
      expect(defaultCfg.managedConfigDir).toBe(defaultCfg.env.XDG_CONFIG_HOME)
    } finally {
      for (const dir of xdgDirs) {
        try { rmSync(dir, { recursive: true, force: true }) } catch {}
      }
      rmSync(workDir, { recursive: true, force: true })
    }
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

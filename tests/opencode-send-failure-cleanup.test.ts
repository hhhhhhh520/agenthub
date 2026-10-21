import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => ({
  root: '',
  send: vi.fn(),
}))

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, tmpdir: () => h.root }
})

vi.mock('@/lib/adapter/process-registry', () => ({
  processRegistry: {
    send: h.send,
    getActiveManagedConfigDirs: () => [],
  },
}))

import { OpenCodeAdapter } from '@/lib/adapter/opencode-adapter'

describe('OpenCodeAdapter — failed send temp config cleanup', () => {
  beforeEach(() => {
    const base = process.env.TEMP || process.env.TMPDIR || '.'
    h.root = mkdtempSync(join(base, 'ah-oc-send-fail-'))
    mkdirSync(join(h.root, 'work'), { recursive: true })
    h.send.mockReset()
    h.send.mockImplementation(async function* () {
      throw new Error('spawn ENOENT')
    })
  })

  afterEach(() => {
    rmSync(h.root, { recursive: true, force: true })
  })

  it('send 在 registry 建 entry 前失败时清理 XDG 目录与 agent 文件', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({
      platform: 'opencode',
      workDir: join(h.root, 'work'),
      agentId: 'agent-send-fail',
      chatSessionId: 'chat-send-fail',
      apiKey: 'sk-send-fail',
      baseUrl: 'https://api.example.com/v1',
      model: 'deepseek-chat',
    })

    await expect((async () => {
      for await (const chunk of adapter.send({ prompt: 'test' })) { void chunk }
    })()).rejects.toThrow(/spawn ENOENT/)

    expect(readdirSync(h.root).filter(name => name.startsWith('agenthub-oc-'))).toEqual([])
    expect(readdirSync(join(h.root, 'work', '.opencode', 'agents'))).toEqual([])
  })
})

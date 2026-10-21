import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => ({
  root: '',
  mockSend: vi.fn(),
}))

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, tmpdir: () => h.root }
})

vi.mock('@/lib/adapter/process-registry', () => ({
  processRegistry: { send: h.mockSend },
}))

// 只让 owner marker 写入失败；agent md / opencode.json 等仍走真实 fs。
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    writeFileSync: (path: Parameters<typeof actual.writeFileSync>[0], data: any, options?: any) => {
      if (String(path).endsWith('.agenthub-owner.json')) {
        const err = new Error('EACCES: owner marker denied') as NodeJS.ErrnoException
        err.code = 'EACCES'
        throw err
      }
      return actual.writeFileSync(path, data, options)
    },
  }
})

import { OpenCodeAdapter } from '@/lib/adapter/opencode-adapter'

describe('OpenCodeAdapter — P2-11 owner publication failure', () => {
  beforeEach(() => {
    const base = process.env.TEMP || process.env.TMPDIR || '.'
    h.root = mkdtempSync(join(base, 'ah-oc-owner-fail-'))
    mkdirSync(join(h.root, 'work'), { recursive: true })
    h.mockSend.mockReset()
    h.mockSend.mockImplementation(async function* () {})
  })

  afterEach(() => {
    rmSync(h.root, { recursive: true, force: true })
  })

  it('owner marker 写失败时 send 拒绝，不继续使用无保护目录', async () => {
    const adapter = new OpenCodeAdapter()
    await adapter.connect({
      platform: 'opencode',
      workDir: join(h.root, 'work'),
      agentId: 'agent-owner-fail',
      chatSessionId: 'chat-owner-fail',
      apiKey: 'sk-owner-fail',
      baseUrl: 'https://api.example.com/v1',
      model: 'deepseek-chat',
    })

    await expect((async () => {
      for await (const chunk of adapter.send({ prompt: 'test' })) { void chunk }
    })()).rejects.toThrow(/owner marker/i)

    expect(h.mockSend).not.toHaveBeenCalled()
  })
})

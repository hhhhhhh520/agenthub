import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// sweepOrphanOpencodeXdgDirs 扫描 tmpdir；测试必须把 tmpdir 指到隔离目录，
// 否则会误删真实运行中的 agenthub-oc-* 配置目录。
const h = vi.hoisted(() => ({
  root: '',
  findMany: vi.fn(),
  getOrchestratorAgent: vi.fn(),
  claudeConfigDir: vi.fn(),
  sweepAgentClaudeConfigDirs: vi.fn(),
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, tmpdir: () => h.root }
})

vi.mock('@/lib/db', () => ({
  prisma: { agent: { findMany: h.findMany } },
}))

vi.mock('@/lib/orchestrator', () => ({
  getOrchestratorAgent: h.getOrchestratorAgent,
}))

vi.mock('@/lib/adapter/claude-code-env', () => ({
  sweepAgentClaudeConfigDirs: h.sweepAgentClaudeConfigDirs,
  claudeConfigDir: h.claudeConfigDir,
}))

vi.mock('@/lib/adapter/opencode-adapter', () => ({
  opencodeCfgDirName: (id: string) => 'agenthub-oc-' + id,
}))

import { sweepWithCurrentConfigs } from '@/lib/services/claude-cfg-maintenance'
import { opencodeCfgDirName } from '@/lib/adapter/opencode-adapter'

describe('sweepWithCurrentConfigs — OpenCode XDG 目录出清', () => {
  beforeEach(() => {
    const base = process.env.TEMP || process.env.TMPDIR || '.'
    h.root = mkdtempSync(join(base, 'ah-oc-sweep-'))
    h.findMany.mockReset().mockResolvedValue([])
    h.getOrchestratorAgent.mockReset().mockResolvedValue(null)
    h.claudeConfigDir.mockReset().mockReturnValue(null)
    h.sweepAgentClaudeConfigDirs.mockReset().mockReturnValue([])
  })

  afterEach(() => {
    rmSync(h.root, { recursive: true, force: true })
  })

  it('保留所有 active 目录（含哨兵/不含哨兵），只删除孤儿目录', async () => {
    const activeWithSentinel = 'active-agent-sentinel'
    const activeWithoutSentinel = 'active-agent-plain'
    const activeWithSentinelDir = join(h.root, opencodeCfgDirName(activeWithSentinel))
    const activeWithoutSentinelDir = join(h.root, opencodeCfgDirName(activeWithoutSentinel))
    const orphanDir = join(h.root, 'agenthub-oc-orphan-123')
    const unrelatedDir = join(h.root, 'not-an-agenthub-dir')

    mkdirSync(activeWithSentinelDir, { recursive: true })
    writeFileSync(join(activeWithSentinelDir, '.agenthub-managed'), '')
    mkdirSync(activeWithoutSentinelDir, { recursive: true })
    mkdirSync(orphanDir, { recursive: true })
    writeFileSync(join(orphanDir, 'opencode.json'), '{}')
    mkdirSync(unrelatedDir, { recursive: true })

    h.findMany.mockResolvedValue([
      { id: activeWithSentinel },
      { id: activeWithoutSentinel },
    ])

    const removed = await sweepWithCurrentConfigs()

    expect(existsSync(activeWithSentinelDir)).toBe(true)
    expect(existsSync(activeWithoutSentinelDir)).toBe(true)
    expect(existsSync(orphanDir)).toBe(false)
    expect(existsSync(unrelatedDir)).toBe(true)
    expect(removed).toEqual(['agenthub-oc-orphan-123'])
  })
})

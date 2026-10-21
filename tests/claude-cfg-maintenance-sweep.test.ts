import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// sweepOrphanOpencodeXdgDirs 扫描 tmpdir；测试必须把 tmpdir 指到隔离目录，
// 否则会误删真实运行中的 agenthub-oc-* 配置目录。
const h = vi.hoisted(() => ({
  root: '',
  activeManagedDirs: [] as string[],
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
  OPENCODE_OWNER_FILE: '.agenthub-owner.json',
}))

vi.mock('@/lib/adapter/process-registry', () => ({
  processRegistry: {
    getActiveManagedConfigDirs: () => h.activeManagedDirs,
  },
}))

import { sweepWithCurrentConfigs } from '@/lib/services/claude-cfg-maintenance'
import { opencodeCfgDirName, OPENCODE_OWNER_FILE } from '@/lib/adapter/opencode-adapter'

describe('sweepWithCurrentConfigs — OpenCode XDG 目录出清', () => {
  beforeEach(() => {
    const base = process.env.TEMP || process.env.TMPDIR || '.'
    h.root = mkdtempSync(join(base, 'ah-oc-sweep-'))
    h.activeManagedDirs = []
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

  it('P2-11: 其他实例 owner 进程仍存活时保留目录', async () => {
    const otherOwnerPid = 424242
    const otherInstanceDir = join(h.root, 'agenthub-oc-other-instance')
    mkdirSync(otherInstanceDir, { recursive: true })
    writeFileSync(join(otherInstanceDir, OPENCODE_OWNER_FILE), JSON.stringify({ pid: otherOwnerPid }))
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: number | string) => {
      if (pid === otherOwnerPid && signal === 0) return true
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    }) as typeof process.kill)
    try {
      const removed = await sweepWithCurrentConfigs()
      expect(existsSync(otherInstanceDir)).toBe(true)
      expect(removed).not.toContain('agenthub-oc-other-instance')
    } finally {
      killSpy.mockRestore()
    }
  })

  it('P2-11 Round 5: 本进程 owner 在非 active/retry 期间也保留目录', async () => {
    const ownInstanceDir = join(h.root, 'agenthub-oc-own-retry')
    mkdirSync(ownInstanceDir, { recursive: true })
    writeFileSync(join(ownInstanceDir, OPENCODE_OWNER_FILE), JSON.stringify({ pid: process.pid }))

    const removed = await sweepWithCurrentConfigs()

    expect(existsSync(ownInstanceDir)).toBe(true)
    expect(removed).not.toContain('agenthub-oc-own-retry')
  })

  it('P2-11 Round 5: owner marker 损坏时保留目录，不能当可删证据', async () => {
    const corruptOwnerDir = join(h.root, 'agenthub-oc-corrupt-owner')
    mkdirSync(corruptOwnerDir, { recursive: true })
    writeFileSync(join(corruptOwnerDir, OPENCODE_OWNER_FILE), '{not-json')

    const removed = await sweepWithCurrentConfigs()

    expect(existsSync(corruptOwnerDir)).toBe(true)
    expect(removed).not.toContain('agenthub-oc-corrupt-owner')
  })

  it('P2-11: owner 进程已退出时清理目录', async () => {
    const deadOwnerPid = 424243
    const staleInstanceDir = join(h.root, 'agenthub-oc-stale-instance')
    mkdirSync(staleInstanceDir, { recursive: true })
    writeFileSync(join(staleInstanceDir, OPENCODE_OWNER_FILE), JSON.stringify({ pid: deadOwnerPid }))
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    }) as typeof process.kill)
    try {
      const removed = await sweepWithCurrentConfigs()
      expect(existsSync(staleInstanceDir)).toBe(false)
      expect(removed).toContain('agenthub-oc-stale-instance')
    } finally {
      killSpy.mockRestore()
    }
  })

  it('P1-03: 保留 ProcessRegistry 正在使用的 per-session 目录', async () => {
    const activeSessionDir = join(h.root, 'agenthub-oc-session-active')
    const orphanSessionDir = join(h.root, 'agenthub-oc-session-orphan')
    mkdirSync(activeSessionDir, { recursive: true })
    mkdirSync(orphanSessionDir, { recursive: true })
    h.activeManagedDirs = [activeSessionDir]

    const removed = await sweepWithCurrentConfigs()

    expect(existsSync(activeSessionDir)).toBe(true)
    expect(existsSync(orphanSessionDir)).toBe(false)
    expect(removed).toContain('agenthub-oc-session-orphan')
    expect(removed).not.toContain('agenthub-oc-session-active')
  })
})

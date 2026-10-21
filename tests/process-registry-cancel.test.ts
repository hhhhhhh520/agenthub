import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'

function createFakeProcess() {
  const proc: any = new EventEmitter()
  proc.pid = Math.floor(Math.random() * 90000) + 1000
  proc.stdin = new PassThrough()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.exitCode = null
  proc.kill = vi.fn()
  proc.unref = vi.fn()
  return proc
}

let targetProcs: any[] = []
let taskkillProcs: any[] = []
let taskkillExitCode = 0

const mockSpawn = vi.fn((command: string) => {
  const proc = createFakeProcess()
  if (command === 'taskkill') {
    taskkillProcs.push(proc)
    // 模拟 taskkill 自身很快退出；P2-08 的确认逻辑会等待这个 exit code。
    setTimeout(() => {
      if (proc.exitCode !== null) return
      proc.exitCode = taskkillExitCode
      proc.emit('exit', taskkillExitCode)
    }, 5)
  } else {
    targetProcs.push(proc)
  }
  return proc
})

vi.mock('child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

let processRegistry: any
let cancellation: typeof import('@/lib/cancellation')

beforeEach(async () => {
  vi.clearAllMocks()
  targetProcs = []
  taskkillProcs = []
  taskkillExitCode = 0

  delete (globalThis as any).__processRegistry
  delete (globalThis as any).__processRegistryCleanupTimer
  delete (globalThis as any).__processRegistryShutdownRegistered

  vi.resetModules()
  // process-registry 会 import 一份新的 cancellation 模块；测试必须用同一实例，
  // 否则取消标记写在旧 Map，registry 看不到（本测试首版踩过）。
  cancellation = await import('@/lib/cancellation')
  const mod = await import('@/lib/adapter/process-registry')
  processRegistry = mod.processRegistry
})

afterEach(() => {
  try { processRegistry.killAll() } catch {}
  for (const id of ['s1', 's2', 's-cancel']) cancellation.clearSessionCancel(id)
})

const CONFIG = (chatSessionId: string, workDir: string) => ({
  workDir,
  chatSessionId,
  command: 'claude',
  args: [],
})

async function drain<T>(iterable: AsyncIterable<T>): Promise<void> {
  for await (const value of iterable) { void value }
}

describe('ProcessRegistry — 会话取消与真实退出', () => {
  it('取消后的 session 拒绝 getOrCreate（不新建进程）', () => {
    cancellation.requestSessionCancel('s-cancel')
    expect(() => processRegistry.getOrCreate('cancel-key', CONFIG('s-cancel', '/tmp/cancel')))
      .toThrow(cancellation.SessionCancelledError)
  })

  it('取消后的 session 拒绝 send（不重试、不 respawn）', async () => {
    cancellation.requestSessionCancel('s-cancel')
    await expect(drain(processRegistry.send('cancel-send', 'hi', CONFIG('s-cancel', '/tmp/cancel'))))
      .rejects.toBeInstanceOf(cancellation.SessionCancelledError)
  })

  it('cancelByOwnerSession 只终止归属会话，另一个会话的进程保留', async () => {
    processRegistry.getOrCreate('key-s1', CONFIG('s1', '/tmp/s1'))
    processRegistry.getOrCreate('key-s2', CONFIG('s2', '/tmp/s2'))
    const p1 = targetProcs[0]
    const p2 = targetProcs[1]

    // 让 s1 进程在优雅窗口内退出
    setTimeout(() => p1.emit('exit', 0), 5)

    const result = await processRegistry.cancelByOwnerSession('s1', { graceMs: 50, forceMs: 100 })

    expect(result).toMatchObject({ total: 1, exited: 1, unconfirmed: [] })
    expect((processRegistry as any).registry.size).toBe(1)
    expect([...(processRegistry as any).registry.values()].some(e => e.process === p2)).toBe(true)
  })

  it('优雅窗口不退出 → 强制 taskkill /F，并等待真实 exit', async () => {
    processRegistry.getOrCreate('force-key', CONFIG('s1', '/tmp/force'))
    const p = targetProcs[0]
    setTimeout(() => p.emit('exit', 0), 30)

    const result = await processRegistry.cancelByOwnerSession('s1', { graceMs: 10, forceMs: 100 })

    expect(result).toMatchObject({ total: 1, exited: 1, unconfirmed: [] })
    const taskkills = mockSpawn.mock.calls.filter(c => c[0] === 'taskkill')
    expect(taskkills.length).toBeGreaterThanOrEqual(2)
    expect(taskkills.some(c => Array.isArray(c[1]) && c[1].includes('/F'))).toBe(true)
  })

  it('P2-08: 父进程退出但 taskkill 树确认失败 → unconfirmed', async () => {
    taskkillExitCode = 1
    processRegistry.getOrCreate('tree-unconfirmed', CONFIG('s1', '/tmp/tree'))
    const p = targetProcs[0]
    setTimeout(() => p.emit('exit', 0), 5)

    const result = await processRegistry.cancelByOwnerSession('s1', { graceMs: 50, forceMs: 50 })

    expect(result.total).toBe(1)
    expect(result.exited).toBe(0)
    expect(result.unconfirmed).toHaveLength(1)
  })

  it('强制后仍不退出 → unconfirmed，registry 保留 entry，不假报成功', async () => {
    processRegistry.getOrCreate('stuck-key', CONFIG('s1', '/tmp/stuck'))

    const result = await processRegistry.cancelByOwnerSession('s1', { graceMs: 10, forceMs: 20 })

    expect(result.total).toBe(1)
    expect(result.exited).toBe(0)
    expect(result.unconfirmed).toHaveLength(1)
    const entry = [...(processRegistry as any).registry.values()][0]
    expect(entry.cancelled).toBe(true)
  })
})

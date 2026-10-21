import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'

/**
 * P2-08 Round 6 regression：并发终止与容量驱逐不能丢失 terminationUnconfirmed。
 * 只在 Windows 上跑：signalProcessTreeAndConfirm 的 taskkill /T 回执确认是 Windows 分支。
 */
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

const mockSpawn = vi.fn((command: string) => {
  const proc = createFakeProcess()
  if (command === 'taskkill') {
    taskkillProcs.push(proc)
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
  rmSync: vi.fn(),
}))

let processRegistry: any

beforeEach(async () => {
  vi.clearAllMocks()
  targetProcs = []
  taskkillProcs = []
  delete (globalThis as any).__processRegistry
  delete (globalThis as any).__processRegistryCleanupTimer
  delete (globalThis as any).__processRegistryShutdownRegistered
  vi.resetModules()
  const mod = await import('@/lib/adapter/process-registry')
  processRegistry = mod.processRegistry
})

afterEach(() => {
  try { processRegistry.killAll() } catch {}
})

function config(chatSessionId: string, workDir: string) {
  return { workDir, chatSessionId, command: 'claude', args: [] }
}

async function waitForTaskkill(count: number): Promise<void> {
  for (let i = 0; i < 200 && taskkillProcs.length < count; i++) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  expect(taskkillProcs.length).toBeGreaterThanOrEqual(count)
}

function releaseTaskkill(index: number, code: number): void {
  const proc = taskkillProcs[index]
  proc.exitCode = code
  proc.emit('exit', code)
}

describe('ProcessRegistry — P2-08 Round 6 tree races', () => {
  it.skipIf(process.platform !== 'win32')(
    '并发取消共享在途终止：第二次不能在第一轮树确认前报告成功',
    async () => {
      processRegistry.getOrCreate('round6-overlap', config('s1', '/tmp/round6-overlap'))
      const parent = targetProcs[0]

      const firstOperation = processRegistry.cancelByOwnerSession('s1', { graceMs: 1000, forceMs: 1000 })
      await waitForTaskkill(1)

      // 第一轮 taskkill /T 已启动但尚未回执；父进程此时退出。
      parent.exitCode = 0
      parent.emit('exit', 0)

      const secondOperation = processRegistry.cancelByOwnerSession('s1', { graceMs: 1000, forceMs: 1000 })
      // 让第二次调用有机会走死父分支；当前实现会在这里提前 resolve。
      await new Promise(resolve => setTimeout(resolve, 10))

      releaseTaskkill(0, 1)
      await waitForTaskkill(2)
      releaseTaskkill(1, 1)
      const [first, second] = await Promise.all([firstOperation, secondOperation])

      expect(first.unconfirmed).toHaveLength(1)
      expect(second.unconfirmed).toHaveLength(1)
    },
  )

  it.skipIf(process.platform !== 'win32')(
    '容量驱逐不能删除未确认树记录',
    async () => {
      processRegistry.getOrCreate('round6-capacity-target', config('s1', '/tmp/round6-capacity'))
      const parent = targetProcs[0]
      setTimeout(() => {
        parent.exitCode = 0
        parent.emit('exit', 0)
      }, 1)

      const firstOperation = processRegistry.cancelByOwnerSession('s1', { graceMs: 1000, forceMs: 1000 })
      await waitForTaskkill(1)
      releaseTaskkill(0, 1)
      await waitForTaskkill(2)
      releaseTaskkill(1, 1)
      const first = await firstOperation
      expect(first.unconfirmed).toHaveLength(1)

      const target = [...(globalThis as any).__processRegistry.values()]
        .find((entry: any) => entry.ownerSessionId === 's1')
      expect(target).toBeDefined()
      const stamp = Date.now()
      target.lastActive = stamp - 60_000

      for (let i = 0; i < 10; i++) {
        const other = processRegistry.getOrCreate(
          `round6-capacity-other-${i}`,
          config('s2', `/tmp/round6-capacity-other-${i}`),
        )
        other.lastActive = stamp + 10_000 + i
      }
      expect((globalThis as any).__processRegistry.size).toBe(11)

      processRegistry.cleanupIdle()

      const targetStillPresent = [...(globalThis as any).__processRegistry.values()]
        .some((entry: any) => entry.ownerSessionId === 's1')
      const secondOperation = processRegistry.cancelByOwnerSession('s1', { graceMs: 1000, forceMs: 1000 })

      if (targetStillPresent) {
        await waitForTaskkill(3)
        releaseTaskkill(2, 1)
      }

      const second = await secondOperation

      expect(second.total).toBe(1)
      expect(second.unconfirmed).toHaveLength(1)
    },
  )
})

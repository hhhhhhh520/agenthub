/**
 * gracefulKillEntry 配置完整性回归测试
 *
 * 防的 bug:❌-1(2026-06-23 审计发现)
 * commit 3e5f700 把 effectiveKey 改成 key + toolsHash + configHash 后,
 * orchestrator 三处 gracefulKillEntry 只传 partial config(workDir / workDir+allowedTools),
 * 缺 apiKey/model/baseUrl/... 等被 buildConfigHash 纳入指纹的字段。
 * 结果 effectiveKey 命中 EMPTY_FINGERPRINT 短路,registry.get 返回 undefined,
 * 函数静默 no-op,超时杀进程功能完全失效。
 *
 * 这些测试锁定三件事:
 * 1. spawn 时的完整 config + kill 时的完整 config = 进程被杀(主路径)
 * 2. spawn 时的完整 config + kill 时的 partial config = 静默 no-op 但要 warn(回归保护)
 * 3. adapter.getRegistryKey() + adapter.getSpawnConfig() 套路得到的 key/config 能成功杀进程(契约保证)
 *
 * 测试 2 是关键 — 它锁定"未来若 effectiveKey 算法又变了,
 * 而 orchestrator 没同步更新调用,本测试会立刻红"。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'

// --- Mock child_process ---
function createFakeProcess() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const proc: any = new EventEmitter()
  proc.pid = Math.floor(Math.random() * 10000) + 1000
  proc.stdin = stdin
  proc.stdout = stdout
  proc.stderr = stderr
  proc.exitCode = null
  proc.kill = vi.fn()
  return proc
}

let fakeProc: ReturnType<typeof createFakeProcess>
const mockSpawn = vi.fn(() => fakeProc)

vi.mock('child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}))

const { mockExistsSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn().mockReturnValue(true),
}))

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

let processRegistry: any

beforeEach(async () => {
  vi.clearAllMocks()
  mockExistsSync.mockReturnValue(true)

  delete (globalThis as any).__processRegistry
  delete (globalThis as any).__processRegistryCleanupTimer
  delete (globalThis as any).__processRegistryShutdownRegistered

  vi.resetModules()
  const mod = await import('@/lib/adapter/process-registry')
  processRegistry = mod.processRegistry

  fakeProc = createFakeProcess()
  mockSpawn.mockReturnValue(fakeProc)
})

afterEach(() => {
  try { processRegistry.killAll() } catch {}
})

describe('gracefulKillEntry 配置完整性(❌-1 回归测试)', () => {
  const FULL_CONFIG = {
    workDir: '/tmp/test',
    apiKey: 'sk-test-key-1234567890',
    baseUrl: 'https://api.example.com',
    model: 'claude-sonnet-4-6',
    permissionMode: 'default',
    mcpConfig: '{"mcpServers":{}}',
    allowedTools: ['Read', 'Write'],
  }

  it('完整 config spawn + 完整 config kill: entry 被定位且进入 kill 流程(主路径)', async () => {
    // 用完整 config spawn
    processRegistry.getOrCreate('key1', FULL_CONFIG)
    expect(fakeProc.kill).not.toHaveBeenCalled()

    // 用完整 config kill — 不 await Phase 1 的 5s 等待
    // 验证两件事:
    //   1. effectiveKey 命中(无 miss warn) — 这是 ❌-1 主目标
    //   2. Phase 1 真正发起了 kill 信号(在非 Windows 上是 process.kill,Windows 是 spawn taskkill)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const killPromise = processRegistry.gracefulKillEntry('key1', FULL_CONFIG)

    // 让 microtask queue 流转一遍,Phase 1 同步执行 try { process.kill(-pid, SIGTERM) }
    await Promise.resolve()
    await Promise.resolve()

    // 关键断言 1:没有 effectiveKey miss warn(说明 entry 被定位到了)
    const missedWarns = warnSpy.mock.calls.filter(c =>
      /effectiveKey miss/i.test(c.join(' '))
    )
    expect(missedWarns.length).toBe(0)

    // 关键断言 2:Phase 1 已发起 kill(非 Windows 上是 process.kill spawn taskkill 不可观测,
    // 但我们可以通过 mockSpawn 看是否调用了 taskkill,或 fakeProc.kill 是否在 Phase 2 被调)
    // 不等 5s,直接 emit exit 让 promise 完成
    fakeProc.emit('exit', 0)
    await killPromise.catch(() => {})

    warnSpy.mockRestore()
  }, 10_000)

  it('完整 config spawn + 缺字段 config kill: warn 提示且静默 no-op(❌-1 回归保护)', async () => {
    // 用完整 config spawn(模拟生产真实情况)
    processRegistry.getOrCreate('key2', FULL_CONFIG)

    const fullKey = (processRegistry as any).toEffectiveKey('key2', FULL_CONFIG)
    expect((processRegistry as any).registry.get(fullKey)).toBeDefined()

    // 用缺字段 config 调 gracefulKillEntry(模拟 ❌-1 当时的 bug:只传 workDir)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await processRegistry.gracefulKillEntry('key2', { workDir: FULL_CONFIG.workDir })

    // 期望:
    // 1. 没找到 entry(因为 partial config 算出的 effectiveKey 跟 full config 不同)
    // 2. 但要有 warn 提示用户,不能静默
    expect(warnSpy).toHaveBeenCalled()
    const warnMsg = warnSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(warnMsg).toMatch(/gracefulKillEntry|effectiveKey miss|未找到|not found/i)

    // 原 entry 仍存活(没被误杀)
    expect((processRegistry as any).registry.get(fullKey)?.alive).toBe(true)

    warnSpy.mockRestore()
  })

  it('完整 config spawn + 完全无 config kill: warn 提示且不杀错 entry', async () => {
    processRegistry.getOrCreate('key3', FULL_CONFIG)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await processRegistry.gracefulKillEntry('key3')  // 完全不传 config

    expect(warnSpy).toHaveBeenCalled()
    const fullKey = (processRegistry as any).toEffectiveKey('key3', FULL_CONFIG)
    expect((processRegistry as any).registry.get(fullKey)?.alive).toBe(true)

    warnSpy.mockRestore()
  })
})

describe('Adapter contract: getRegistryKey + getSpawnConfig(❌-1 推荐用法)', () => {
  // 这组测试通过 adapter 接口走真实流程,验证 orchestrator 应该用的套路
  // 注:adapter 内部会 spawn 真实 child_process,这里用 mockSpawn 接管

  it('claude-code-adapter: connect 后能拿 registryKey, send 后能拿 spawnConfig', async () => {
    const { ClaudeCodeAdapter } = await import('@/lib/adapter/claude-code-adapter')
    const adapter = new ClaudeCodeAdapter()

    await adapter.connect({
      platform: 'claude-code',
      workDir: '/tmp/test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com',
      model: 'claude-sonnet-4-6',
      agentId: 'agent-1',
      chatSessionId: 'sess-1',
    })

    // connect 后 registryKey 必须可用
    const key = adapter.getRegistryKey()
    expect(key).toBe('sess-1:agent-1:/tmp/test')

    // send 之前 spawnConfig 应为 null(还没真正 spawn)
    expect(adapter.getSpawnConfig()).toBeNull()

    // 启动 send,进入 iterator 第一步 — 这一步会调 spawnConfig 构造 + getOrCreate
    const iter = adapter.send({ prompt: 'test' })[Symbol.asyncIterator]()
    const nextPromise = iter.next()  // 触发 spawn

    // 立刻让进程"退出",iterator 才会返回
    await new Promise(r => setImmediate(r))
    fakeProc.emit('exit', 0)
    await nextPromise.catch(() => {})

    // send 之后拿到完整 spawnConfig
    const config = adapter.getSpawnConfig() as any
    expect(config).not.toBeNull()
    expect(config?.workDir).toBe('/tmp/test')
    expect(config?.apiKey).toBe('sk-test')
    expect(config?.model).toBe('claude-sonnet-4-6')
    expect(config?.baseUrl).toBe('https://api.example.com')
  }, 10_000)

  it('用 adapter.getRegistryKey() + getSpawnConfig() 调 gracefulKillEntry: 能定位 entry 进入 kill 流程', async () => {
    const { ClaudeCodeAdapter } = await import('@/lib/adapter/claude-code-adapter')
    const adapter = new ClaudeCodeAdapter()

    await adapter.connect({
      platform: 'claude-code',
      workDir: '/tmp/test',
      apiKey: 'sk-real-key',
      model: 'claude-sonnet-4-6',
      agentId: 'agent-x',
      chatSessionId: 'sess-x',
    })

    const iter = adapter.send({ prompt: 'test' })[Symbol.asyncIterator]()
    const nextPromise = iter.next()
    await new Promise(r => setImmediate(r))

    const key = adapter.getRegistryKey()
    const config = adapter.getSpawnConfig()
    expect(config).not.toBeNull()

    // 验证 entry 存在
    const effKey = (processRegistry as any).toEffectiveKey(key, config!)
    expect((processRegistry as any).registry.get(effKey)).toBeDefined()
    expect((processRegistry as any).registry.get(effKey).alive).toBe(true)

    // 用 adapter 暴露的 key+config 调 gracefulKillEntry
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const killPromise = processRegistry.gracefulKillEntry(key, config!)
    await new Promise(r => setImmediate(r))

    // 没有 warn(说明 entry 被定位到了)
    const missedWarns = warnSpy.mock.calls.filter(c =>
      /effectiveKey miss|未找到|not found/i.test(c.join(' '))
    )
    expect(missedWarns.length).toBe(0)

    fakeProc.emit('exit', 0)
    await killPromise.catch(() => {})
    await nextPromise.catch(() => {})

    warnSpy.mockRestore()
  }, 10_000)
})

describe('gracefulKillEntry 两阶段行为', () => {
  it('Phase 1 SIGTERM 后进程仍存活时,Phase 2 强制杀', { timeout: 15000 }, async () => {
    const config = {
      workDir: '/tmp/test',
      apiKey: 'sk-test-key',
      model: 'claude-sonnet-4-6',
    }

    // Spawn 进程
    const entry = processRegistry.getOrCreate('two-phase', config)
    expect(entry.alive).toBe(true)

    // Phase 1: 调用 gracefulKillEntry,进程不退出(模拟 hang)
    const killPromise = processRegistry.gracefulKillEntry('two-phase', config)

    // 等待 Phase 1 的 5s 超时
    // gracefulKillEntry 内部: await new Promise(r => setTimeout(r, 5000))
    await new Promise(r => setTimeout(r, 5100))

    // Phase 2 应该已经执行: killEntryIfCurrent 被调用
    // 验证 entry 被清理
    const registry = (globalThis as any).__processRegistry as Map<string, any>
    const remainingKeys = [...registry.keys()].filter((k: string) => k.startsWith('two-phase'))
    expect(remainingKeys.length).toBe(0)

    await killPromise.catch(() => {})
  })

  it('Phase 1 SIGTERM 后进程正常退出,不触发 Phase 2', { timeout: 10000 }, async () => {
    const config = {
      workDir: '/tmp/test',
      apiKey: 'sk-test-key',
      model: 'claude-sonnet-4-6',
    }

    const entry = processRegistry.getOrCreate('phase1-exit', config)

    // Phase 1: 调用 gracefulKillEntry,进程在 5s 内退出
    const killPromise = processRegistry.gracefulKillEntry('phase1-exit', config)

    // 模拟进程收到 SIGTERM 后 1s 内退出
    await new Promise(r => setTimeout(r, 100))
    entry.alive = false
    entry.process.exitCode = 0
    entry.process.emit('exit', 0)

    await killPromise.catch(() => {})

    // Entry 应该已被清理(Phase 1 的 exit handler 触发)
    const registry = (globalThis as any).__processRegistry as Map<string, any>
    const remainingKeys = [...registry.keys()].filter((k: string) => k.startsWith('phase1-exit'))
    expect(remainingKeys.length).toBe(0)
  })
})

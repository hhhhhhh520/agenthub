import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import type { ChildProcess } from 'child_process'

function createFakeProcess(): ChildProcess & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough } {
  const proc = new EventEmitter() as ChildProcess & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number; exitCode: number | null; kill: ReturnType<typeof vi.fn> }
  proc.pid = Math.floor(Math.random() * 10000) + 1000
  proc.stdin = new PassThrough()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.exitCode = null
  proc.kill = vi.fn()
  return proc
}

let fakeProc: ReturnType<typeof createFakeProcess>
const mockSpawn = vi.fn(() => fakeProc)

vi.mock('child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}))

const { mockExistsSync, mockMkdirSync, mockWriteFileSync, mockUnlinkSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn().mockReturnValue(true),
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
}))

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
  unlinkSync: mockUnlinkSync,
}))

let processRegistry: any

async function loadRegistry() {
  delete (globalThis as any).__processRegistry
  delete (globalThis as any).__processRegistryCleanupTimer
  delete (globalThis as any).__processRegistryShutdownRegistered
  vi.resetModules()
  const mod = await import('@/lib/adapter/process-registry')
  processRegistry = mod.processRegistry
}

async function collect(gen: AsyncIterable<any>): Promise<any[]> {
  const results: any[] = []
  for await (const chunk of gen) results.push(chunk)
  return results
}

async function nextChunk(gen: AsyncIterator<any>, timeoutMs = 500): Promise<any> {
  return Promise.race([
    gen.next(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for next chunk')), timeoutMs)),
  ])
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.useRealTimers()
  mockExistsSync.mockReturnValue(true)
  fakeProc = createFakeProcess()
  mockSpawn.mockReturnValue(fakeProc)
  await loadRegistry()
})

afterEach(() => {
  try { processRegistry.killAll() } catch {}
  vi.useRealTimers()
})

describe('ProcessRegistry refactor regressions', () => {
  it('routes permission responses by effective key when allowedTools changes the registry key', async () => {
    const writes: string[] = []
    const originalWrite = fakeProc.stdin.write.bind(fakeProc.stdin)
    vi.spyOn(fakeProc.stdin, 'write').mockImplementation((chunk: any, ...args: any[]) => {
      writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk))
      return originalWrite(chunk, ...args)
    })

    const gen = processRegistry.send('perm-tools', 'do it', {
      workDir: '/dir',
      allowedTools: ['Read'],
      permissionMode: 'default',
    })[Symbol.asyncIterator]()

    setTimeout(() => {
      fakeProc.stdout.write(Buffer.from(JSON.stringify({
        type: 'control_request',
        request_id: 'req-tools',
        request: { subtype: 'can_use_tool', tool_name: 'Read', input: { file_path: '/tmp/a.txt' } },
      }) + '\n'))
    }, 10)

    const first = await nextChunk(gen)
    expect(first.value.type).toBe('permission_request')

    const accepted = processRegistry.respondPermissionByRequestId('req-tools', { behavior: 'allow' })
    expect(accepted).toBe(true)
    expect(writes.some(w => w.includes('control_response') && w.includes('req-tools'))).toBe(true)

    await gen.return?.(undefined)
  })

  it('does not let an old exit handler delete a newer entry registered under the same key', () => {
    const entry1 = processRegistry.getOrCreate('exit-race', { workDir: '/dir' })
    const oldProc = entry1.process
    const registry = (globalThis as any).__processRegistry as Map<string, any>

    const proc2 = createFakeProcess()
    const entry2 = {
      ...entry1,
      process: proc2,
      stdin: proc2.stdin,
      alive: true,
      lastActive: Date.now(),
    }
    registry.set('exit-race', entry2)

    oldProc.emit('exit')

    expect(registry.get('exit-race')).toBe(entry2)
  })

  it('keeps public killEntry(key) compatibility and kills the current entry', () => {
    processRegistry.getOrCreate('public-kill', { workDir: '/dir' })
    const registry = (globalThis as any).__processRegistry as Map<string, any>

    processRegistry.killEntry('public-kill')

    expect(registry.has('public-kill')).toBe(false)
  })

  it('resumes the latest captured CLI session when rebuilding after a crash', async () => {
    const mainSpawns: Array<{ proc: ReturnType<typeof createFakeProcess>; args: string[] }> = []

    mockSpawn.mockImplementation((command: string, args: string[]) => {
      const proc = createFakeProcess()
      if (command !== 'taskkill') {
        mainSpawns.push({ proc, args })
        if (mainSpawns.length === 1) {
          setTimeout(() => {
            proc.stdout.write(Buffer.from(JSON.stringify({ session_id: 'sess-established' }) + '\n'))
            proc.exitCode = 1
            proc.stdout.end()
            proc.emit('exit')
          }, 10)
        } else {
          setTimeout(() => {
            proc.stdout.write(Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'))
          }, 10)
        }
      }
      fakeProc = proc
      return proc
    })

    await collect(processRegistry.send('resume-after-crash', 'prompt', { workDir: '/dir', sessionId: null }))

    expect(mainSpawns.length).toBeGreaterThanOrEqual(2)
    const retryArgs = mainSpawns[1].args
    const resumeIndex = retryArgs.indexOf('--resume')
    expect(resumeIndex).toBeGreaterThanOrEqual(0)
    expect(retryArgs[resumeIndex + 1]).toBe('sess-established')
  })

  it('uses a Set for pending permission waits so resolved permissions cannot spin the read loop', async () => {
    const { readFileSync } = await vi.importActual<typeof import('fs')>('fs')
    const source = readFileSync('src/lib/adapter/process-registry.ts', 'utf-8')

    expect(source).toContain('permissionWaiters')
    expect(source).not.toContain('pendingPermissionPromises')
    expect(source).not.toContain('pendingPermissionSet')  // 防回退：上一版的过渡名字
  })

  // ====================  2a 加固  ====================

  it('gracefulKillEntry routes to the entry registered under effectiveKey when config has allowedTools', async () => {
    const config = { workDir: '/dir', allowedTools: ['Read'] }
    processRegistry.getOrCreate('gk-tools', config)
    const registry = (globalThis as any).__processRegistry as Map<string, any>

    // 应有一个 entry 在 effectiveKey 下（key + toolsHash），而非裸 key
    expect(registry.has('gk-tools')).toBe(false)
    expect([...registry.keys()].some(k => k.startsWith('gk-tools:'))).toBe(true)

    // 用 raw key + config 调用 gracefulKillEntry：应能命中 effectiveKey
    await processRegistry.gracefulKillEntry('gk-tools', config)
    expect([...registry.keys()].some(k => k.startsWith('gk-tools:'))).toBe(false)
  }, 10000)

  it('readRound flushes bufferStr before throwing so a session_id stuck in the tail buffer is rescued for retry', async () => {
    const mainSpawns: Array<{ proc: ReturnType<typeof createFakeProcess>; args: string[] }> = []

    mockSpawn.mockImplementation((command: string, args: string[]) => {
      const proc = createFakeProcess()
      if (command !== 'taskkill') {
        mainSpawns.push({ proc, args })
        if (mainSpawns.length === 1) {
          // 关键：session_id 这一行没有结尾换行，会留在 bufferStr 里
          // 然后进程立刻 exit，readRound 通常会直接 throw 而不 flush 这一行
          setTimeout(() => {
            proc.stdout.write(Buffer.from(JSON.stringify({ session_id: 'sess-trapped-in-buffer' })))
            proc.exitCode = 1
            setImmediate(() => {
              proc.stdout.end()
              proc.emit('exit')
            })
          }, 10)
        } else {
          setTimeout(() => {
            proc.stdout.write(Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'))
          }, 10)
        }
      }
      fakeProc = proc
      return proc
    })

    await collect(processRegistry.send('buffer-flush', 'prompt', { workDir: '/dir', sessionId: null }))

    expect(mainSpawns.length).toBeGreaterThanOrEqual(2)
    const retryArgs = mainSpawns[1].args
    const resumeIndex = retryArgs.indexOf('--resume')
    expect(resumeIndex).toBeGreaterThanOrEqual(0)
    expect(retryArgs[resumeIndex + 1]).toBe('sess-trapped-in-buffer')
  })

  it('wrappedResolve guards against synchronous resolve before pendingPermissionPromise is assigned', async () => {
    const { readFileSync } = await vi.importActual<typeof import('fs')>('fs')
    const source = readFileSync('src/lib/adapter/process-registry.ts', 'utf-8')

    // 必须在 delete 之前判断 permissionPromise 已赋值，否则同步 resolve 会 delete(undefined)
    const wrappedResolveBlock = source.match(/const wrappedResolve = [\s\S]*?\n\s{14}\}/)
    expect(wrappedResolveBlock).toBeTruthy()
    expect(wrappedResolveBlock![0]).toMatch(/if\s*\(\s*permissionPromise\s*\)/)
  })

  it('send catch block does not shadow outer entry binding with a same-named local const', async () => {
    const { readFileSync } = await vi.importActual<typeof import('fs')>('fs')
    const source = readFileSync('src/lib/adapter/process-registry.ts', 'utf-8')

    // 抽取 send 函数体（从签名行到下一个方法定义之前）
    const sendStart = source.indexOf('async *send(')
    expect(sendStart).toBeGreaterThan(-1)
    const sendEnd = source.indexOf('private async *readRound', sendStart)
    expect(sendEnd).toBeGreaterThan(sendStart)
    const sendBody = source.slice(sendStart, sendEnd)

    // catch 块和后置块里的内层 const 必须改名，避免遮蔽外层 let entry
    expect(sendBody).not.toMatch(/const entry = this\.registry\.get/)
  })

  it('resolved permission promise is removed from race set so subsequent waits do not include it', async () => {
    // 行为断言：触发 permission_request -> 必须进入 entry.permissionWaiters（size === 1）
    // respondPermissionByRequestId 调用栈到 wrappedResolve 全是同步链 —— 返回时 size 立即变 0
    // 改动 6 回退（Set 不删 resolved promise）的话下半段断言会红。
    const gen = processRegistry.send('perm-set-behavior', 'prompt', { workDir: '/dir' })[Symbol.asyncIterator]()

    setTimeout(() => {
      fakeProc.stdout.write(Buffer.from(JSON.stringify({
        type: 'control_request',
        request_id: 'req-A',
        request: { subtype: 'can_use_tool', tool_name: 'Read', input: { path: '/a' } },
      }) + '\n'))
    }, 10)

    const first = await nextChunk(gen)
    expect(first.value.type).toBe('permission_request')

    // 取唯一 entry（无 allowedTools → effectiveKey === key，直接拿 values 更稳）
    const registry = (globalThis as any).__processRegistry as Map<string, any>
    const entries = [...registry.values()]
    expect(entries).toHaveLength(1)
    const entry = entries[0]

    // 上半段：promise 已加入 Set
    expect(entry.permissionWaiters.size).toBe(1)

    processRegistry.respondPermissionByRequestId('req-A', { behavior: 'allow' })

    // 下半段：respond 内部走 wrappedResolve 同步链，返回时 Set 已清 0
    // 不加 await Promise.resolve()：链是同步的，加了反而误导
    expect(entry.permissionWaiters.size).toBe(0)

    // 关闭流让 gen 退出
    fakeProc.stdout.write(Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'))
    await gen.return?.(undefined)
  })
})

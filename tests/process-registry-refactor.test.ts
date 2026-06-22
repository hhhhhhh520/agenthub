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
  // 测试 fixture 在 beforeEach 删 __processRegistryShutdownRegistered 标志,
  // 导致每个测试重新注册 SIGTERM/SIGINT/beforeExit listener,累积到 11+ 触发 MaxListenersExceededWarning。
  // 这里清理,保持测试基础设施健康。
  process.removeAllListeners('SIGTERM')
  process.removeAllListeners('SIGINT')
  process.removeAllListeners('beforeExit')
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

  // ====================  2b entry 互斥锁  ====================

  it('serializes concurrent sends to the same effectiveKey (FIFO baton-passing lock)', async () => {
    // 同 effectiveKey 同时跑两个 send：第二个必须等第一个的 stream 全部 yield 完才写 stdin
    const writeOrder: string[] = []

    const procA = createFakeProcess()
    mockSpawn.mockImplementation(() => {
      // 同 effectiveKey 复用同一进程（persistent CLI）
      fakeProc = procA
      return procA
    })

    // spy stdin.write 顺序，按 payload 内容区分 A/B
    const originalAWrite = procA.stdin.write.bind(procA.stdin)
    vi.spyOn(procA.stdin, 'write').mockImplementation((chunk: any, ...args: any[]) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk)
      if (text.includes('prompt-A')) writeOrder.push('A-write')
      else if (text.includes('prompt-B')) writeOrder.push('B-write')
      return originalAWrite(chunk, ...args)
    })

    // send-A 启动并推进
    const genA = processRegistry.send('mutex-fifo', 'prompt-A', { workDir: '/dir' })[Symbol.asyncIterator]()
    const aFirstChunk = genA.next()  // 推进 iterator 触发 readRound

    // 让 A 完成 stdin.write
    await new Promise(r => setTimeout(r, 30))
    expect(writeOrder).toEqual(['A-write'])  // A 已写，B 还没启动

    // 紧接着启动 send-B
    const genB = processRegistry.send('mutex-fifo', 'prompt-B', { workDir: '/dir' })[Symbol.asyncIterator]()
    const bFirstChunk = genB.next()  // 推进 B iterator,B 应当卡在 acquireLock

    await new Promise(r => setTimeout(r, 50))
    // FIFO 锁:B 必须等 A 完成才能写 stdin
    expect(writeOrder).toEqual(['A-write'])  // B 还没写 stdin

    // A 完成 (yield result chunk)
    procA.stdout.write(Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'))
    await aFirstChunk
    // 让 A 跑完
    try {
      while (true) {
        const r = await Promise.race([
          genA.next(),
          new Promise(res => setTimeout(() => res({ done: true, value: undefined } as any), 200)),
        ]) as any
        if (r.done) break
      }
    } catch {}

    // A 释放锁后 B 应当能拿到锁并写 stdin
    await new Promise(r => setTimeout(r, 50))
    expect(writeOrder).toContain('B-write')
    // FIFO 严格:A-write 一定在 B-write 之前
    expect(writeOrder.indexOf('A-write')).toBeLessThan(writeOrder.indexOf('B-write'))

    // 让 B 收尾
    procA.stdout.write(Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'))
    await bFirstChunk.catch(() => {})
    await genB.return?.(undefined)
  }, 10000)

  it('sets entry.busy to true during send and clears it after send completes', async () => {
    // 红-绿 核心: 摘掉 lock → busy 永不为 true → 上半段红
    // 正常完成路径:send 返回后 persist 进程的 entry 还在 registry,可以断言 busy 被 release
    const registry = (globalThis as any).__processRegistry as Map<string, any>

    const gen = processRegistry.send('lifecycle', 'prompt', { workDir: '/dir' })[Symbol.asyncIterator]()

    // 触发 permission_request 让 gen 进入 readRound 的 while 循环,此时已 acquireLock
    setTimeout(() => {
      fakeProc.stdout.write(Buffer.from(JSON.stringify({
        type: 'control_request', request_id: 'req-lifecycle',
        request: { subtype: 'can_use_tool', tool_name: 'Read', input: { file_path: '/a.txt' } },
      }) + '\n'))
    }, 10)

    const first = await nextChunk(gen)
    expect(first.value.type).toBe('permission_request')

    // 上半段:send 在 readRound 内暂停 → busy 应为 true
    const entry = registry.get('lifecycle')
    expect(entry).toBeDefined()
    expect(entry.busy).toBe(true)  // ← 摘掉 lock 这条会红

    // 正常完成 send
    processRegistry.respondPermissionByRequestId('req-lifecycle', { behavior: 'allow' })
    setTimeout(() => {
      fakeProc.stdout.write(Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'))
    }, 10)
    await collect({ [Symbol.asyncIterator]: () => gen } as any)

    // 下半段:send 正常返回后 finally 释放了锁 → busy 应为 false
    // (persist 进程 entry 还在 registry,可以断言)
    const entryAfter = registry.get('lifecycle')
    expect(entryAfter).toBeDefined()
    expect(entryAfter.busy).toBe(false)  // ← 摘掉 finally release 这条会红
  }, 10000)

  it('throws EntryDiedWhileWaitingError when entry is killed while a send is waiting for the lock', async () => {
    // A 持锁中（busy=true,通过 stdout 不吐数据让 readRound 挂着）
    // B 调用 send 进入排队
    // 外部 kill entry → killEntryIfCurrent 唤醒所有 waiter
    // 关键断言: B 排在 entry.busyWaiters 里(无锁实现时 busyWaiters 字段不存在 → 红)
    const procA = createFakeProcess()
    const procB = createFakeProcess()
    let n = 0
    mockSpawn.mockImplementation(() => {
      n++
      if (n === 1) { fakeProc = procA; return procA }
      fakeProc = procB; return procB
    })

    const genA = processRegistry.send('mutex-die', 'prompt-A', { workDir: '/dir' })[Symbol.asyncIterator]()
    const aFirstChunk = genA.next()  // 推进 A iterator,进入 readRound 持锁
    await new Promise(r => setTimeout(r, 30))

    const registry = (globalThis as any).__processRegistry as Map<string, any>
    const entryA = registry.get('mutex-die')
    expect(entryA).toBeDefined()
    // A 持锁:busy=true
    expect(entryA.busy).toBe(true)
    // busyWaiters 字段必须存在(无锁实现时此处会红:undefined.length)
    expect(entryA.busyWaiters).toBeDefined()

    // B 启动排队
    const genB = processRegistry.send('mutex-die', 'prompt-B', { workDir: '/dir' })[Symbol.asyncIterator]()
    const bFirstChunk = genB.next()  // 推进 B iterator,进入 acquireLock 排队
    await new Promise(r => setTimeout(r, 30))

    // B 应当在排队
    expect(entryA.busyWaiters.length).toBe(1)

    // 杀 procA — exit handler 应当唤醒所有 waiter 并 splice 队列
    procA.exitCode = 1
    procA.emit('exit')
    await new Promise(r => setTimeout(r, 20))

    // 唤醒后 busyWaiters 应当被清空(splice)
    expect(entryA.busyWaiters.length).toBe(0)

    // B 收到 EntryDiedWhileWaitingError → retry → 用 procB 完成
    setTimeout(() => {
      procB.stdout.write(Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'))
    }, 50)

    // B 必须能完成,不卡死
    try {
      while (true) {
        const r = await Promise.race([
          genB.next(),
          new Promise(res => setTimeout(() => res({ done: true, value: undefined } as any), 3000)),
        ]) as any
        if (r.done) break
      }
    } catch {}

    // procB 必须被 spawn 过 (B 走 retry rebuild 路径)
    expect(n).toBeGreaterThanOrEqual(2)

    await aFirstChunk.catch(() => {})
    await genA.return?.(undefined)
  }, 10000)

  it('throws EntryBusyTimeoutError when waiting for the lock exceeds LOCK_WAIT_TIMEOUT_MS', async () => {
    // 直接测 acquireLock 的超时:用 getOrCreate 拿到 entry,手动置 busy=true 模拟"有人持锁不还",
    // 再调 acquireLock 排队,推进 5min+1s 应抛 EntryBusyTimeoutError。
    // 不通过 send() 走全流程 —— send 的 60s no-data timeout 会在 5min 之前先把 entry 杀掉,干扰测试。
    vi.useFakeTimers()

    const entry = processRegistry.getOrCreate('mutex-timeout', { workDir: '/dir' })
    expect(entry.busy).toBe(false)
    expect(entry.busyWaiters).toEqual([])

    // 手动模拟"有人持锁"
    entry.busy = true

    // B 调用 acquireLock,因为 busy=true 必走排队分支
    const acquirePromise = (processRegistry as any).acquireLock(entry, 'mutex-timeout')
    expect(entry.busyWaiters.length).toBe(1)

    // 先注册 expect 等 rejection —— 这样 timer 一 fire reject,assertion 立即吸收,
    // 不会有 unhandled rejection 窗口。
    const assertPromise = expect(acquirePromise).rejects.toThrow(/busy/i)

    // 推进 5min + 1s 触发 timeout
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000)

    // 等 assertion 兑现
    await assertPromise
    // 队列被清空(waiter 自己 splice 出去)
    expect(entry.busyWaiters.length).toBe(0)
    // entry.busy 还是 true(没人释放),这是预期的 —— 模拟"对方占着不还"

    vi.useRealTimers()
    // 清理 entry —— 否则 spawnProcess 创建的 idle cleanup 定时器会泄漏到下个测试
    processRegistry.killEntry('mutex-timeout')
  }, 10000)

  // ====================  2c.1 清理统一  ====================

  it('cleanupEntry is idempotent (cleanedUp flag guards multiple invocations)', () => {
    // 直接测 cleanupEntry 的幂等性:多次调用安全,不重复清理映射/唤醒/unlink
    const entry = processRegistry.getOrCreate('cleanup-idem', { workDir: '/dir' })
    expect(entry.cleanedUp).toBe(false)

    // 塞一个 fake permission 看 cleanup 会不会清掉
    entry.pendingPermissions.set('req-1', {
      requestId: 'req-1', toolName: 'X', toolInput: {}, resolve: () => {}
    } as any)

    // 第一次 cleanup
    ;(processRegistry as any).cleanupEntry(entry)
    expect(entry.cleanedUp).toBe(true)
    expect(entry.alive).toBe(false)
    expect(entry.pendingPermissions.size).toBe(0)  // ← 摘 .clear() 这条会红

    // 第二次 cleanup 必须是 no-op(幂等):再塞一个 entry 不会被清(因为 cleanedUp=true 直接 return)
    entry.pendingPermissions.set('req-2', {
      requestId: 'req-2', toolName: 'X', toolInput: {}, resolve: () => {}
    } as any)
    ;(processRegistry as any).cleanupEntry(entry)
    // 第二次没有清,所以这条还在(证明真的 no-op,不是重复跑)
    expect(entry.pendingPermissions.size).toBe(1)

    processRegistry.killEntry('cleanup-idem')
  })

  it('killEntryIfCurrent clears pendingPermissions Map (not just requestIdToKey)', () => {
    // 复审挂的修补:pendingPermissions.clear() 漏了 —— 之前只删 requestIdToKey 反向索引,Map 本体残留
    // 现在走 cleanupEntry,Map 也被清空
    const entry = processRegistry.getOrCreate('clear-perm', { workDir: '/dir' })
    entry.pendingPermissions.set('req-A', {
      requestId: 'req-A', toolName: 'X', toolInput: {}, resolve: () => {}
    } as any)
    expect(entry.pendingPermissions.size).toBe(1)

    processRegistry.killEntry('clear-perm')
    // entry 被 kill 后 pendingPermissions Map 应该清空(走 cleanupEntry)
    expect(entry.pendingPermissions.size).toBe(0)  // ← 摘 .clear() 这条会红
  })

  it('readNdjsonRound symmetrically flushes bufferStr before throwing to rescue sessionID', async () => {
    // 对称于 readRound 的 bufferStr 抢救:NDJSON 协议下 sessionID 卡在 bufferStr 末尾(无换行)
    // 应当在 throw 之前 flush 一次,把 sessionID 注入 entry.sessionId
    const procA = createFakeProcess()
    fakeProc = procA
    mockSpawn.mockReturnValue(procA)

    const entry = processRegistry.getOrCreate('ndjson-flush', {
      workDir: '/dir',
      format: 'ndjson',
      promptAsArg: true,  // 不写 stdin
    })
    expect(entry.sessionId).toBeNull()

    const gen = (processRegistry as any).readNdjsonRound('ndjson-flush', entry, 'prompt')

    // 异步写数据 + 死亡:让 readNdjsonRound 先进入 while 循环,onData 把数据 push 到 bufferStr,
    // 然后死亡触发 throw 路径,flushTailForSessionId 应当抢救出 sessionID
    setTimeout(() => {
      procA.stdout.write(Buffer.from(JSON.stringify({ sessionID: 'sess-from-ndjson-tail' })))  // 无换行
      procA.exitCode = 1
    }, 30)

    try {
      while (true) {
        const r = await Promise.race([
          gen.next(),
          new Promise(res => setTimeout(() => res({ done: true, value: undefined } as any), 500)),
        ]) as any
        if (r.done) break
      }
    } catch {}

    // flushTailForSessionId 应当从 bufferStr 抢救出 sessionID(NDJSON 字段名是 sessionID)
    expect(entry.sessionId).toBe('sess-from-ndjson-tail')  // ← 摘 ndjson 的 flush 这条会红

    processRegistry.killEntry('ndjson-flush')
  }, 10000)

  // ====================  2c.2 配置指纹  ====================

  it('changing apiKey produces a different effectiveKey (forces new entry, fixes review #13)', () => {
    // 复审 #13:apiKey/model 改了 10 分钟内不生效,因为旧 entry 用老配置,新 send 复用旧 entry。
    // 配置指纹后:apiKey 变化 → effectiveKey 变化 → 不同 entry,自动 spawn 新进程。
    const registry = (globalThis as any).__processRegistry as Map<string, any>

    const entryOld = processRegistry.getOrCreate('cfg-apikey', {
      workDir: '/dir',
      apiKey: 'sk-old',
    })
    const entryNew = processRegistry.getOrCreate('cfg-apikey', {
      workDir: '/dir',
      apiKey: 'sk-new',
    })

    // 两个 entry 必须不同(不同 effectiveKey)
    expect(entryOld).not.toBe(entryNew)
    // registry 里两个 effectiveKey 都存在
    const keys = [...registry.keys()].filter(k => k.startsWith('cfg-apikey'))
    expect(keys.length).toBe(2)

    processRegistry.killEntry('cfg-apikey')
  })

  it('changing model produces a different effectiveKey', () => {
    const registry = (globalThis as any).__processRegistry as Map<string, any>

    processRegistry.getOrCreate('cfg-model', { workDir: '/dir', model: 'claude-sonnet-4-6' })
    processRegistry.getOrCreate('cfg-model', { workDir: '/dir', model: 'claude-opus-4-8' })

    const keys = [...registry.keys()].filter(k => k.startsWith('cfg-model'))
    expect(keys.length).toBe(2)

    processRegistry.killEntry('cfg-model')
  })

  it('model bracket suffix [1m] is stripped before hashing (avoid spurious cache miss)', () => {
    // claude-sonnet-4-6 和 claude-sonnet-4-6[1m] spawn 出的进程行为相同,
    // 不应触发重建。指纹算法把 [...] 后缀 strip 后再 hash。
    const registry = (globalThis as any).__processRegistry as Map<string, any>

    const e1 = processRegistry.getOrCreate('cfg-bracket', { workDir: '/dir', model: 'claude-sonnet-4-6' })
    const e2 = processRegistry.getOrCreate('cfg-bracket', { workDir: '/dir', model: 'claude-sonnet-4-6[1m]' })

    expect(e1).toBe(e2)  // 同一 entry,模型字段规范化后等价

    processRegistry.killEntry('cfg-bracket')
  })

  it('env field does NOT enter fingerprint (preserves process reuse for dynamic env)', () => {
    // env 是开放容器,可能含 TIMESTAMP 之类动态值;进指纹会让每次 send 都重 spawn,违反进程复用目标。
    // 设计决策:env 不进指纹,如果用户真的传了影响行为的 env,自己负责管理。
    const e1 = processRegistry.getOrCreate('cfg-env', {
      workDir: '/dir',
      env: { TIMESTAMP: '1' },
    })
    const e2 = processRegistry.getOrCreate('cfg-env', {
      workDir: '/dir',
      env: { TIMESTAMP: '2' },
    })

    expect(e1).toBe(e2)  // env 不进指纹,同一 entry

    processRegistry.killEntry('cfg-env')
  })

  it('disallowedTools order does not affect fingerprint', () => {
    const e1 = processRegistry.getOrCreate('cfg-tools-order', {
      workDir: '/dir',
      disallowedTools: ['A', 'B', 'C'],
    })
    const e2 = processRegistry.getOrCreate('cfg-tools-order', {
      workDir: '/dir',
      disallowedTools: ['C', 'A', 'B'],
    })

    expect(e1).toBe(e2)  // 排序后等价

    processRegistry.killEntry('cfg-tools-order')
  })

  it('apiKey is not exposed in effectiveKey (hashed, not plaintext)', () => {
    // 安全断言:apiKey 经 SHA-256 截断 16 字符,effectiveKey 里看不到明文。
    const registry = (globalThis as any).__processRegistry as Map<string, any>

    const secretKey = 'sk-supersecret-do-not-leak-12345'
    processRegistry.getOrCreate('cfg-secret', { workDir: '/dir', apiKey: secretKey })

    const keys = [...registry.keys()].filter(k => k.startsWith('cfg-secret'))
    expect(keys.length).toBe(1)
    expect(keys[0]).not.toContain(secretKey)  // 不能明文出现
    expect(keys[0]).not.toContain('supersecret')

    processRegistry.killEntry('cfg-secret')
  })
})

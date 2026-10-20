import { describe, it, expect, beforeEach } from 'vitest'

// Reset the module between tests to get a fresh lock Map
let acquireSessionLock: typeof import('@/lib/session-lock').acquireSessionLock

beforeEach(async () => {
  const { vi } = await import('vitest')
  vi.resetModules()
  const mod = await import('@/lib/session-lock')
  acquireSessionLock = mod.acquireSessionLock
})

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('SessionLock — acquireSessionLock', () => {
  it('returns a release function', async () => {
    const release = await acquireSessionLock('test-basic')
    expect(typeof release).toBe('function')
    release()
  })

  it('allows acquiring lock for different sessions concurrently', async () => {
    const release1 = await acquireSessionLock('session-a')
    const release2 = await acquireSessionLock('session-b')
    expect(typeof release1).toBe('function')
    expect(typeof release2).toBe('function')
    release1()
    release2()
  })

  it('serializes concurrent requests for the same session', async () => {
    const order: number[] = []

    // First lock held until manually released
    const release1 = await acquireSessionLock('serial-test')

    // Second lock should wait for first
    const p2 = acquireSessionLock('serial-test').then(async (release2) => {
      order.push(2)
      release2()
    })

    // Third lock should wait for second
    const p3 = acquireSessionLock('serial-test').then(async (release3) => {
      order.push(3)
      release3()
    })

    // Small delay then release first
    await wait(50)
    order.push(1)
    release1()

    await Promise.all([p2, p3])
    expect(order).toEqual([1, 2, 3])
  })

  it('fails closed when previous holder never releases (no concurrent phase writes)', async () => {
    // Acquire first lock but never release
    await acquireSessionLock('timeout-test')

    // Second lock must reject instead of proceeding concurrently (phase-write race root cause).
    await expect(acquireSessionLock('timeout-test', undefined, { timeoutMs: 50 })).rejects.toMatchObject({
      name: 'SessionBusyError',
      code: 'SESSION_BUSY',
    })
  })

  it('timed-out waiter unlinks itself: later waiter still chains to the real holder', async () => {
    const releaseHolder = await acquireSessionLock('unlink-test')
    await expect(
      acquireSessionLock('unlink-test', undefined, { timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: 'SESSION_BUSY' })

    // 持有者释放后，后续 acquire 必须立即成功——不能被超时等待者留下的死 promise 再卡 60s。
    releaseHolder()
    const start = Date.now()
    const releaseNext = await acquireSessionLock('unlink-test')
    expect(Date.now() - start).toBeLessThan(100)
    releaseNext()
  })

  // 复核指出的关键回归：A 持锁，B/C 同时排队，B 先超时，A 释放后 C 必须拿到锁。
  // 旧链式实现里 C 等的是 B 的死 promise，会继续超时；本测试在旧实现上必红。
  it('A holds, B/C queue, B times out, A releases => C acquires (no queue chain break)', async () => {
    const sid = 'queue-chain-break'
    const releaseA = await acquireSessionLock(sid)
    const order: string[] = []

    const pB = acquireSessionLock(sid, undefined, { timeoutMs: 30 })
      .then(releaseB => { order.push('B'); releaseB() })
      .catch(err => { order.push(`B:${err.code || err.name}`) })

    const pC = acquireSessionLock(sid, undefined, { timeoutMs: 800 })
      .then(releaseC => { order.push('C'); releaseC() })
      .catch(err => { order.push(`C:${err.code || err.name}`) })

    await wait(60)
    expect(order).toEqual(['B:SESSION_BUSY'])
    releaseA()
    await Promise.all([pB, pC])

    expect(order).toEqual(['B:SESSION_BUSY', 'C'])
  })

  it('aborted waiter is removed; later waiter still gets the lock', async () => {
    const sid = 'abort-waiter'
    const releaseA = await acquireSessionLock(sid)
    const controller = new AbortController()
    const order: string[] = []

    const pB = acquireSessionLock(sid, controller.signal)
      .then(releaseB => { order.push('B'); releaseB() })
      .catch(err => { order.push(`B:${err.name}`) })
    const pC = acquireSessionLock(sid, undefined, { timeoutMs: 500 })
      .then(releaseC => { order.push('C'); releaseC() })
      .catch(err => { order.push(`C:${err.name}`) })

    controller.abort()
    await wait(20)
    releaseA()
    await Promise.all([pB, pC])

    expect(order[0]).toBe('B:AbortError')
    expect(order).toContain('C')
  })

  // 新语义：持有者 abort 只代表客户端断开，后台执行可能还在跑，不能释放锁。
  it('holder abort does not release the lock; caller must release in finally', async () => {
    const sid = 'abort-holder'
    const controller = new AbortController()
    const releaseA = await acquireSessionLock(sid, controller.signal)

    controller.abort()
    await expect(
      acquireSessionLock(sid, undefined, { timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: 'SESSION_BUSY' })

    releaseA()
    const releaseB = await acquireSessionLock(sid)
    expect(typeof releaseB).toBe('function')
    releaseB()
  })

  it('calling release multiple times does not throw and does not double-handoff', async () => {
    const sid = 'idempotent-test'
    const release = await acquireSessionLock(sid)
    const order: string[] = []

    const pB = acquireSessionLock(sid, undefined, { timeoutMs: 500 })
      .then(releaseB => { order.push('B'); releaseB() })
      .catch(err => { order.push(`B:${err.name}`) })
    const pC = acquireSessionLock(sid, undefined, { timeoutMs: 500 })
      .then(releaseC => { order.push('C'); releaseC() })
      .catch(err => { order.push(`C:${err.name}`) })

    release()
    release() // 二次释放不得把 C 提前放进来
    await Promise.all([pB, pC])

    expect(order).toEqual(['B', 'C'])
  })

  it('cleans up lock entry after release', async () => {
    const release = await acquireSessionLock('cleanup-test')
    release()

    // Next acquire should not wait (lock was cleaned up)
    const start = Date.now()
    const release2 = await acquireSessionLock('cleanup-test')
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(100) // Should be instant
    release2()
  })
})

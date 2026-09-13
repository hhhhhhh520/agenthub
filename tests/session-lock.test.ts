import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Reset the module between tests to get a fresh lock Map
let acquireSessionLock: typeof import('@/lib/session-lock').acquireSessionLock

beforeEach(async () => {
  vi.resetModules()
  const mod = await import('@/lib/session-lock')
  acquireSessionLock = mod.acquireSessionLock
})

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
    await new Promise(r => setTimeout(r, 50))
    order.push(1)
    release1()

    await Promise.all([p2, p3])
    expect(order).toEqual([1, 2, 3])
  })

  it('fails closed when previous holder never releases (no concurrent phase writes)', async () => {
    // Acquire first lock but never release
    await acquireSessionLock('timeout-test')

    // Second lock must reject instead of proceeding concurrently (phase-write race root cause).
    // timeoutMs 缩到 50ms：只测"超时抛错"分支语义，不等生产 60s。
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

  it('keeps serializing after a timed-out waiter (order preserved)', async () => {
    const order: number[] = []
    const releaseHolder = await acquireSessionLock('order-after-timeout')

    // B 等锁超时抛错（不等 60s）
    await expect(
      acquireSessionLock('order-after-timeout', undefined, { timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: 'SESSION_BUSY' })

    // C 在持有者释放后仍能正常串行拿到锁
    const pC = acquireSessionLock('order-after-timeout').then((releaseC) => {
      order.push(2)
      releaseC()
    })
    await new Promise((r) => setTimeout(r, 20))
    order.push(1)
    releaseHolder()
    await pC
    expect(order).toEqual([1, 2])
  })

  it('releases lock when abort signal fires', async () => {
    const controller = new AbortController()
    const release1 = await acquireSessionLock('abort-test', controller.signal)

    // Abort should release the lock
    controller.abort()

    // Second acquire should succeed since first was aborted
    const release2 = await acquireSessionLock('abort-test')
    expect(typeof release2).toBe('function')
    release2()
  })

  it('calling release multiple times does not throw', async () => {
    const release = await acquireSessionLock('idempotent-test')
    release()
    expect(() => release()).not.toThrow()
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

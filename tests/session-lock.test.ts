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

  it('proceeds even if previous lock holder never releases (timeout)', async () => {
    // Acquire first lock but never release
    await acquireSessionLock('timeout-test')

    // Second lock should eventually succeed after the internal 60s timeout
    // We test that it doesn't hang by using a shorter test timeout
    // In practice, this tests the timeout mechanism exists
    const release2 = await acquireSessionLock('timeout-test')
    expect(typeof release2).toBe('function')
    release2()
  }, 70_000) // Allow 70s for the 60s timeout

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

import { describe, it, expect, vi } from 'vitest'
import { withTimeout, TimeoutError } from '@/lib/orchestrator/timeout'

/** next() 永不 resolve，return() 可正常收敛——避免测试挂在 async generator 的 return 上。 */
function stuckSource() {
  return {
    [Symbol.asyncIterator]() { return this },
    next: () => new Promise<IteratorResult<number>>(() => {}),
    return: async () => ({ done: true as const, value: undefined }),
  }
}

/** 非合作 generator：next 和 return 都永不 settle；return 不能无限拖住超时错误。 */
function nonCooperativeSource() {
  return {
    [Symbol.asyncIterator]() { return this },
    next: () => new Promise<IteratorResult<number>>(() => {}),
    return: () => new Promise<IteratorResult<number>>(() => {}),
  }
}

async function drain(iterable: AsyncIterable<number>) {
  for await (const value of iterable) { void value }
}

describe('withTimeout — 有界清理', () => {
  it('onTimeout 抛错仍抛 TimeoutError（清理错误不能吞掉超时语义）', async () => {
    const onTimeout = vi.fn().mockRejectedValue(new Error('cleanup failed'))
    const start = Date.now()

    await expect(
      drain(withTimeout(stuckSource(), 20, { onTimeout, cleanupTimeoutMs: 50 })),
    ).rejects.toBeInstanceOf(TimeoutError)

    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(Date.now() - start).toBeLessThan(500)
  })

  it('onTimeout 挂起时在 cleanupTimeoutMs 后仍抛 TimeoutError', async () => {
    const onTimeout = vi.fn(() => new Promise<void>(() => {}))
    const start = Date.now()

    await expect(
      drain(withTimeout(stuckSource(), 20, { onTimeout, cleanupTimeoutMs: 30 })),
    ).rejects.toBeInstanceOf(TimeoutError)

    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(Date.now() - start).toBeLessThan(500)
  })

  it('P2-01: iterator.return() 永不 settle 时仍能在 cleanupTimeoutMs 内有界抛 TimeoutError', async () => {
    const onTimeout = vi.fn(async () => {})
    const source = nonCooperativeSource()
    const start = Date.now()

    await expect(
      drain(withTimeout(source, 20, { onTimeout, cleanupTimeoutMs: 30 })),
    ).rejects.toBeInstanceOf(TimeoutError)

    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(Date.now() - start).toBeLessThan(500)
  }, 2000)

  it('P2-01: iterator.return() reject 不能覆盖 TimeoutError', async () => {
    const source = {
      [Symbol.asyncIterator]() { return this },
      next: () => new Promise<IteratorResult<number>>(() => {}),
      return: async () => { throw new Error('return failed') },
    }

    await expect(
      drain(withTimeout(source, 20, { cleanupTimeoutMs: 30 })),
    ).rejects.toBeInstanceOf(TimeoutError)
  }, 2000)

  it('正常完成不触发 onTimeout', async () => {
    const onTimeout = vi.fn(async () => {})
    const source = {
      [Symbol.asyncIterator]() {
        let n = 0
        return {
          next: async () => (n++ < 2 ? { done: false as const, value: n } : { done: true as const, value: undefined }),
          return: async () => ({ done: true as const, value: undefined }),
        }
      },
    }

    const values: number[] = []
    for await (const v of withTimeout(source, 1000, { onTimeout })) values.push(v)

    expect(values).toEqual([1, 2])
    expect(onTimeout).not.toHaveBeenCalled()
  })
})

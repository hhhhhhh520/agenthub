import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTaskPoller, type TaskSnapshot } from '../src/lib/task-poller'

// 档位与阈值一律写字面量（毫秒/次数），不引用实现常量——
// 调度节奏被改动时测试必须变红。

const task = (status: string, id = 't1') => ({ id, status })

function harness(fetchImpl: (call: number) => unknown, redoFast = false) {
  let tasks: TaskSnapshot[] = [{ id: 'seed', status: 'seed' }]
  const loadingCalls: boolean[] = []
  const seenSignals: AbortSignal[] = []
  let calls = 0
  const fetchTasks = vi.fn(async (signal: AbortSignal) => {
    seenSignals.push(signal)
    calls += 1
    const v = fetchImpl(calls)
    if (v instanceof Error) throw v
    return v
  })
  const setTasks = vi.fn((updater: (prev: TaskSnapshot[]) => TaskSnapshot[]) => {
    tasks = updater(tasks)
  })
  const setLoading = vi.fn((v: boolean) => {
    loadingCalls.push(v)
  })
  const poller = createTaskPoller({ fetchTasks, setTasks, setLoading, redoFast })
  return {
    poller,
    tasks: () => tasks,
    loadingCalls,
    calls: () => calls,
    firstSignal: () => seenSignals[0],
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createTaskPoller 轮询生命周期', () => {
  it('首轮同步发起请求，成功后落盘并关闭 loading', async () => {
    const h = harness(() => [task('pending')])
    expect(h.calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.tasks()).toEqual([task('pending')])
    expect(h.loadingCalls).toEqual([true, false])
    h.poller.stop()
  })

  it('有变化保持 3s，无变化降频 10s', async () => {
    const h = harness((call) => (call === 1 ? [task('pending')] : [task('completed')]))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls()).toBe(2)
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls()).toBe(3)
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls()).toBe(3)
    await vi.advanceTimersByTimeAsync(7_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls()).toBe(4)
    h.poller.stop()
  })

  it('连续失败 5 次转 30s 探测，成功一次即恢复 3s（不永久停摆）', async () => {
    const h = harness((call) => (call <= 5 ? new Error('boom') : [task('pending')]))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls()).toBe(5)
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls()).toBe(5)
    await vi.advanceTimersByTimeAsync(27_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls()).toBe(6)
    expect(h.tasks()).toEqual([task('pending')])
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls()).toBe(7)
    h.poller.stop()
  })

  it('stop 后不再发起任何请求（卸载刹车，删掉即无限自旋）', async () => {
    const h = harness(() => [task('pending')])
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls()).toBe(1)
    h.poller.stop()
    expect(h.firstSignal().aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls()).toBe(1)
  })

  it('脏载荷不进任务板，按失败记一次且首轮不卡转圈', async () => {
    const h = harness((call) => (call === 1 ? {} : [task('pending')]))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.tasks()).toEqual([])
    expect(h.loadingCalls).toEqual([true, false])
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls()).toBe(2)
    expect(h.tasks()).toEqual([task('pending')])
    h.poller.stop()
  })

  it('redo 常开时无变化也保持 1s', async () => {
    const h = harness(() => [task('pending')], true)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls()).toBe(2)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls()).toBe(3)
    h.poller.stop()
  })

  it('探测期 redo 让位于 30s（errorProbe 优先）', async () => {
    const h = harness((call) => (call <= 5 ? new Error('boom') : [task('pending')]), true)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls()).toBe(5)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls()).toBe(5)
    await vi.advanceTimersByTimeAsync(29_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls()).toBe(6)
    h.poller.stop()
  })

  it('stop 时有在途请求：落地后也不再排期（finally 刹车）', async () => {
    let tasks: TaskSnapshot[] = []
    let calls = 0
    let release: (v: unknown) => void = () => {}
    const fetchTasks = vi.fn(() => {
      calls += 1
      return new Promise<unknown>((res) => {
        release = res
      })
    })
    const poller = createTaskPoller({
      fetchTasks,
      setTasks: (updater) => {
        tasks = updater(tasks)
      },
      setLoading: () => {},
      redoFast: false,
    })
    expect(calls).toBe(1)
    poller.stop() // 在途：call1 尚未 settle
    release([task('pending')])
    await vi.advanceTimersByTimeAsync(0)
    expect(tasks).toEqual([task('pending')])
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
  })
})

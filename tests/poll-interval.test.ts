import { describe, expect, it } from 'vitest'
import { computePollInterval } from '../src/lib/poll-interval'

// 期望值一律写字面量，不引用 POLL_INTERVALS / ERROR_PROBE_THRESHOLD——
// 引用被测函数读的同一常量会让断言同义反复：把档位数值改掉测试也不会红。

describe('computePollInterval 档位与优先级', () => {
  it('redo 快速档 = 1s，且优先于空闲降频', () => {
    expect(
      computePollInterval({ errorCount: 0, changedSinceLastPoll: false, redoFast: true })
    ).toBe(1_000)
  })

  it('有变化时保持活跃节奏 3s', () => {
    expect(
      computePollInterval({ errorCount: 0, changedSinceLastPoll: true, redoFast: false })
    ).toBe(3_000)
  })

  it('连续无变化时空闲降频到 10s', () => {
    expect(
      computePollInterval({ errorCount: 0, changedSinceLastPoll: false, redoFast: false })
    ).toBe(10_000)
  })

  it('连续失败达到 5 次转入 30s 低频探测而非停摆', () => {
    expect(
      computePollInterval({ errorCount: 5, changedSinceLastPoll: true, redoFast: false })
    ).toBe(30_000)
  })

  it('失败 4 次未达阈值：非 redo 时仍按“有无变化”判定', () => {
    expect(
      computePollInterval({ errorCount: 4, changedSinceLastPoll: true, redoFast: false })
    ).toBe(3_000)
    expect(
      computePollInterval({ errorCount: 4, changedSinceLastPoll: false, redoFast: false })
    ).toBe(10_000)
  })

  it('失败未达阈值时 redo 仍优先', () => {
    expect(
      computePollInterval({ errorCount: 4, changedSinceLastPoll: false, redoFast: true })
    ).toBe(1_000)
  })

  it('探测期间 redo 请求也让位于故障探测', () => {
    expect(
      computePollInterval({ errorCount: 6, changedSinceLastPoll: true, redoFast: true })
    ).toBe(30_000)
  })
})

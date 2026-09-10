import { describe, expect, it } from 'vitest'
import {
  computePollInterval,
  ERROR_PROBE_THRESHOLD,
  POLL_INTERVALS,
} from '../src/lib/poll-interval'

describe('computePollInterval', () => {
  it('redo 快速档优先于空闲降频', () => {
    expect(
      computePollInterval({ errorCount: 0, changedSinceLastPoll: false, redoFast: true })
    ).toBe(POLL_INTERVALS.redoFast)
  })

  it('有变化时保持活跃节奏 3s', () => {
    expect(
      computePollInterval({ errorCount: 0, changedSinceLastPoll: true, redoFast: false })
    ).toBe(POLL_INTERVALS.active)
  })

  it('连续无变化时空闲降频到 10s', () => {
    expect(
      computePollInterval({ errorCount: 0, changedSinceLastPoll: false, redoFast: false })
    ).toBe(POLL_INTERVALS.idle)
  })

  it(`连续失败达到 ${ERROR_PROBE_THRESHOLD} 次转入低频探测而非停摆`, () => {
    expect(
      computePollInterval({ errorCount: ERROR_PROBE_THRESHOLD, changedSinceLastPoll: true, redoFast: false })
    ).toBe(POLL_INTERVALS.errorProbe)
  })

  it('失败次数未达阈值时不受影响（redo 仍优先）', () => {
    expect(
      computePollInterval({ errorCount: ERROR_PROBE_THRESHOLD - 1, changedSinceLastPoll: false, redoFast: true })
    ).toBe(POLL_INTERVALS.redoFast)
  })

  it('探测期间 redo 请求也让位于故障探测', () => {
    expect(
      computePollInterval({ errorCount: ERROR_PROBE_THRESHOLD + 1, changedSinceLastPoll: true, redoFast: true })
    ).toBe(POLL_INTERVALS.errorProbe)
  })
})

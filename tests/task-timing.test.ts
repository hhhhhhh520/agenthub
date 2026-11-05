import { describe, expect, it } from 'vitest'
import { getLastTraceEvent, getTaskStartedAt, parseTaskTrace } from '../src/lib/task-timing'

describe('task timing', () => {
  it('parses malformed traces as empty', () => {
    expect(parseTaskTrace('not-json')).toEqual([])
    expect(parseTaskTrace(null)).toEqual([])
    expect(parseTaskTrace('[{"event":"start"}]')).toEqual([{ event: 'start' }])
  })

  it('uses the latest valid start trace', () => {
    const trace = JSON.stringify([
      { ts: '2026-11-04T10:00:00.000Z', event: 'start' },
      { ts: '2026-11-04T10:01:00.000Z', event: 'retry' },
      { ts: '2026-11-04T10:02:00.000Z', event: 'start' },
    ])

    expect(getTaskStartedAt({ createdAt: '2026-11-04T09:00:00.000Z', trace }))
      .toBe('2026-11-04T10:02:00.000Z')
  })

  it('falls back to createdAt when no start trace exists', () => {
    expect(getTaskStartedAt({ createdAt: '2026-11-04T09:00:00.000Z', trace: '[]' }))
      .toBe('2026-11-04T09:00:00.000Z')
  })

  it('reports the last trace event for retry detection', () => {
    const trace = JSON.stringify([
      { event: 'start' },
      { event: 'retry' },
    ])
    expect(getLastTraceEvent(trace)).toBe('retry')
    expect(getLastTraceEvent('invalid')).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { deriveWaitingReason } from '../src/lib/waiting-state'

describe('deriveWaitingReason', () => {
  it('surfaces permission and user waits before CLI output', () => {
    expect(deriveWaitingReason({ loading: true, pendingPermissionCount: 1 }).label).toBe('等待权限确认')
    expect(deriveWaitingReason({ loading: false, awaitingInput: 'agent_qa' }).label).toBe('等待你的输入')
  })

  it('surfaces retry, tool, thinking and streaming states', () => {
    expect(deriveWaitingReason({ loading: true, retrying: true }).label).toBe('自动重试中')
    expect(deriveWaitingReason({ loading: true, runningTool: 'Bash' }).label).toBe('工具执行中 · Bash')
    expect(deriveWaitingReason({ loading: true, thinking: true }).label).toBe('模型思考中')
    expect(deriveWaitingReason({ loading: true, streaming: true }).label).toBe('接收输出中')
  })

  it('falls back to CLI output while loading and clears when idle', () => {
    expect(deriveWaitingReason({ loading: true }).label).toBe('等待 CLI 输出')
    expect(deriveWaitingReason({ loading: false })).toEqual({ kind: null, label: null })
  })
})

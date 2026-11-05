export type WaitingKind = 'permission' | 'user' | 'retry' | 'tool' | 'thinking' | 'streaming' | 'cli'

export interface WaitingInput {
  loading: boolean
  pendingPermissionCount?: number
  awaitingInput?: string | null
  retrying?: boolean
  runningTool?: string | null
  thinking?: boolean
  streaming?: boolean
}

export interface WaitingReason {
  kind: WaitingKind | null
  label: string | null
}

/** 把聊天流的瞬时状态翻译成用户能理解的「现在在等什么」。 */
export function deriveWaitingReason(input: WaitingInput): WaitingReason {
  if ((input.pendingPermissionCount ?? 0) > 0) {
    return { kind: 'permission', label: '等待权限确认' }
  }
  if (input.awaitingInput) {
    return { kind: 'user', label: '等待你的输入' }
  }
  if (!input.loading) {
    return { kind: null, label: null }
  }
  if (input.retrying) {
    return { kind: 'retry', label: '自动重试中' }
  }
  if (input.runningTool) {
    return { kind: 'tool', label: `工具执行中 · ${input.runningTool}` }
  }
  if (input.thinking) {
    return { kind: 'thinking', label: '模型思考中' }
  }
  if (input.streaming) {
    return { kind: 'streaming', label: '接收输出中' }
  }
  return { kind: 'cli', label: '等待 CLI 输出' }
}

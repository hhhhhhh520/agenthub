import { describe, expect, it } from 'vitest'
import {
  applyProjectPermissionEvent,
  type ProjectPendingPermission,
} from '@/lib/project-permissions'

const pending = (requestId: string): ProjectPendingPermission => ({
  requestId,
  toolName: 'Bash',
  toolInput: { command: 'ls' },
  agentId: 'agent-1',
})

describe('project-permissions — P3 #22 项目页权限事件', () => {
  it('permission_request 追加，重复 requestId 不重复弹', () => {
    const event = {
      type: 'permission_request',
      agentId: 'agent-1',
      data: { requestId: 'r1', toolName: 'Bash', toolInput: { command: 'ls' } },
    }
    let state = applyProjectPermissionEvent([], event)
    state = applyProjectPermissionEvent(state, event)
    expect(state).toEqual([pending('r1')])
  })

  it('replay 的 permission_request 不弹（执行已结束）', () => {
    const state = applyProjectPermissionEvent([], {
      type: 'permission_request',
      agentId: 'agent-1',
      replay: true,
      data: { requestId: 'r1', toolName: 'Bash', toolInput: {} },
    })
    expect(state).toEqual([])
  })

  it('permission_cancel 按 requestId 移除', () => {
    const state = applyProjectPermissionEvent([pending('r1'), pending('r2')], {
      type: 'permission_cancel',
      data: { requestId: 'r1' },
    })
    expect(state.map(p => p.requestId)).toEqual(['r2'])
  })
})

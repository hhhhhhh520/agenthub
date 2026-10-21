export interface ProjectPendingPermission {
  requestId: string
  toolName: string
  toolInput: Record<string, unknown>
  agentId: string
}

export interface ProjectPermissionEvent {
  type: string
  agentId?: string
  replay?: boolean
  data?: {
    requestId?: string
    toolName?: string
    toolInput?: Record<string, unknown>
  }
}

export function applyProjectPermissionEvent(
  prev: ProjectPendingPermission[],
  event: ProjectPermissionEvent,
): ProjectPendingPermission[] {
  if (event.type === 'permission_request') {
    if (event.replay) return prev
    const requestId = event.data?.requestId
    if (!requestId) return prev
    const next: ProjectPendingPermission = {
      requestId,
      toolName: event.data?.toolName || '',
      toolInput: event.data?.toolInput || {},
      agentId: event.agentId || '',
    }
    return [...prev.filter(p => p.requestId !== requestId), next]
  }
  if (event.type === 'permission_cancel') {
    const requestId = event.data?.requestId
    return requestId ? prev.filter(p => p.requestId !== requestId) : prev
  }
  return prev
}

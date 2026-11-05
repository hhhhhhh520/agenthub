export interface AgentMembershipPresence {
  status: string
  session: {
    id: string
    title: string
    updatedAt: string | Date
  }
}

export interface AgentPresenceSummary {
  currentSession: {
    id: string
    title: string
    status: string
    updatedAt: string | Date
  } | null
  workingSessionCount: number
  sessionCount: number
}

function toTime(value: string | Date): number {
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

/**
 * 智能体页只读 SessionMember.status（per-session），不再读已废弃的 Agent.status。
 * 优先展示正在工作的会话；否则展示最近更新的会话。
 */
export function summarizeAgentPresence(
  memberships: AgentMembershipPresence[],
): AgentPresenceSummary {
  const workingSessionCount = memberships.filter(member => member.status === 'working').length
  const sorted = [...memberships].sort((a, b) => {
    const aWorking = a.status === 'working' ? 1 : 0
    const bWorking = b.status === 'working' ? 1 : 0
    if (aWorking !== bWorking) return bWorking - aWorking
    return toTime(b.session.updatedAt) - toTime(a.session.updatedAt)
  })
  const current = sorted[0]

  return {
    currentSession: current
      ? {
          id: current.session.id,
          title: current.session.title,
          status: current.status,
          updatedAt: current.session.updatedAt,
        }
      : null,
    workingSessionCount,
    sessionCount: memberships.length,
  }
}

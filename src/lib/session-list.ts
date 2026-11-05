import { stripProtocolMarkers } from '@/lib/message-parser'

export type SessionGroupMode = 'time' | 'project'

export interface SessionListMember {
  agentId?: string
  agent?: { name?: string | null } | null
}

export interface SessionListItem {
  id: string
  title: string
  type?: string
  phase?: string
  projectDir?: string
  updatedAt: string
  createdAt?: string
  isPinned?: boolean
  isArchived?: boolean
  members?: SessionListMember[]
  _count?: { messages?: number; members?: number; agents?: number }
}

export interface SessionGroup<T extends SessionListItem> {
  key: string
  label: string
  projectDir?: string
  sessions: T[]
}

const TIME_GROUP_ORDER = ['今天', '昨天', '本周', '更早'] as const

const PLACEHOLDER_TITLES = new Set(['新会话', '新项目', '群聊'])

/**
 * 首条需求 -> 会话标题。只做展示层的确定性压缩，不调用模型。
 * 保留原文（rawContent），标题只是 Session.title 的派生值。
 */
export function deriveSessionTitle(message: string, maxLength = 32): string | null {
  if (!message) return null

  let text = stripProtocolMarkers(message)
  text = text
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/(^|[\s(])([*_])([^*_]+)\2/g, '$1$3')
    .replace(/^\s+/, '')
    .replace(/^(?:@\S+\s*)+/, '')
    .replace(/\s+/g, ' ')
    .replace(/^[，,。.；;：:、\s]+/, '')
    .replace(/[，,。.；;：:、\s]+$/, '')
    .trim()

  if (!text) return null

  const chars = Array.from(text)
  if (chars.length <= maxLength) return text

  const clipped = chars
    .slice(0, maxLength)
    .join('')
    .replace(/[，,。.；;：:、\s]+$/, '')
  return `${clipped}…`
}

/** 只有系统占位标题允许被首条消息覆盖；用户手动改过的标题不动。 */
export function isPlaceholderSessionTitle(title: string | null | undefined): boolean {
  if (title === null || title === undefined) return false
  const value = title.trim()
  if (!value) return true
  if (PLACEHOLDER_TITLES.has(value)) return true
  if (/^与\s*Orchestrator\s*对话$/i.test(value)) return true
  return /^私聊\s*[:：]/.test(value)
}

export function normalizeProjectDir(projectDir: string | null | undefined): string {
  return (projectDir || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
}

export function getProjectLabel(projectDir: string | null | undefined): string {
  const normalized = normalizeProjectDir(projectDir)
  if (!normalized) return '未绑定项目'
  const segment = normalized.split('/').filter(Boolean).pop()
  return segment || normalized
}

export function getSessionTypeLabel(type: string | null | undefined): string {
  if (type === 'private') return '私聊'
  if (type === 'group') return '群聊'
  if (type === 'orchestrator') return 'Orchestrator'
  return '会话'
}

export function filterSessions<T extends SessionListItem>(sessions: T[], query: string): T[] {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return sessions

  return sessions.filter((session) => {
    const memberNames = (session.members || [])
      .map(member => member.agent?.name || '')
      .join(' ')
    const haystack = [
      session.title,
      session.projectDir || '',
      memberNames,
      getSessionTypeLabel(session.type),
    ].join(' ').toLowerCase()
    return haystack.includes(keyword)
  })
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function getTimeGroup(updatedAt: string, now: Date): string {
  const date = new Date(updatedAt)
  if (Number.isNaN(date.getTime())) return '更早'

  const dayDiff = Math.floor((startOfDay(now) - startOfDay(date)) / (24 * 60 * 60 * 1000))
  if (dayDiff <= 0) return '今天'
  if (dayDiff === 1) return '昨天'
  if (dayDiff < 7) return '本周'
  return '更早'
}

function compareSessions(a: SessionListItem, b: SessionListItem): number {
  const aPinned = a.isPinned ? 1 : 0
  const bPinned = b.isPinned ? 1 : 0
  if (aPinned !== bPinned) return bPinned - aPinned

  const aTime = new Date(a.updatedAt).getTime()
  const bTime = new Date(b.updatedAt).getTime()
  const safeATime = Number.isNaN(aTime) ? 0 : aTime
  const safeBTime = Number.isNaN(bTime) ? 0 : bTime
  return safeBTime - safeATime
}

function sortSessions<T extends SessionListItem>(sessions: T[]): T[] {
  return [...sessions].sort(compareSessions)
}

/**
 * 会话分组。置顶会话单独成组，避免按项目/时间分组后把置顶淹没在组内。
 * 时间组固定为 今天/昨天/本周/更早；项目组按最近活动倒序。
 */
export function groupSessions<T extends SessionListItem>(
  sessions: T[],
  mode: SessionGroupMode,
  now = new Date(),
): SessionGroup<T>[] {
  const sorted = sortSessions(sessions)
  const pinned = sorted.filter(session => session.isPinned)
  const rest = sorted.filter(session => !session.isPinned)
  const groups: SessionGroup<T>[] = []

  if (pinned.length > 0) {
    groups.push({ key: 'pinned', label: '置顶', sessions: pinned })
  }

  if (mode === 'time') {
    const buckets = new Map<string, T[]>()
    for (const session of rest) {
      const label = getTimeGroup(session.updatedAt, now)
      const bucket = buckets.get(label)
      if (bucket) bucket.push(session)
      else buckets.set(label, [session])
    }
    for (const label of TIME_GROUP_ORDER) {
      const bucket = buckets.get(label)
      if (bucket && bucket.length > 0) {
        groups.push({ key: `time:${label}`, label, sessions: bucket })
      }
    }
    return groups
  }

  const projectBuckets = new Map<string, SessionGroup<T>>()
  for (const session of rest) {
    const projectDir = normalizeProjectDir(session.projectDir)
    const key = projectDir ? `project:${projectDir.toLowerCase()}` : 'project:__unbound__'
    const existing = projectBuckets.get(key)
    if (existing) {
      existing.sessions.push(session)
    } else {
      projectBuckets.set(key, {
        key,
        label: getProjectLabel(projectDir),
        projectDir,
        sessions: [session],
      })
    }
  }

  const projectGroups = Array.from(projectBuckets.values()).sort((a, b) => {
    const aLatest = new Date(a.sessions[0]?.updatedAt || 0).getTime() || 0
    const bLatest = new Date(b.sessions[0]?.updatedAt || 0).getTime() || 0
    if (aLatest !== bLatest) return bLatest - aLatest
    return a.label.localeCompare(b.label, 'zh-CN')
  })

  groups.push(...projectGroups)
  return groups
}

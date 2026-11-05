import { describe, expect, it } from 'vitest'
import {
  deriveSessionTitle,
  filterSessions,
  getProjectLabel,
  getSessionTypeLabel,
  groupSessions,
  isPlaceholderSessionTitle,
  normalizeProjectDir,
  type SessionListItem,
} from '../src/lib/session-list'

function session(overrides: Partial<SessionListItem> & { id: string; title: string; updatedAt: string }): SessionListItem {
  return { type: 'group', projectDir: '', ...overrides }
}

describe('deriveSessionTitle', () => {
  it('strips protocol markers, markdown and leading mentions', () => {
    expect(deriveSessionTitle('[DISCUSSION_SUMMARY][STATUS:success] @前端工程师 **帮我** 写一个 [登录页](https://x.test)'))
      .toBe('帮我 写一个 登录页')
    expect(deriveSessionTitle('## 实现登录\n\n- 先做接口\n- 再做页面'))
      .toBe('实现登录 先做接口 再做页面')
  })

  it('truncates by code point and removes trailing punctuation', () => {
    const title = deriveSessionTitle('一'.repeat(40))
    expect(title).toBe(`${'一'.repeat(32)}…`)
    expect(deriveSessionTitle('一'.repeat(31) + '，')).toBe('一'.repeat(31))
  })

  it('returns null for empty, attachment-only or mention-only messages', () => {
    expect(deriveSessionTitle('')).toBeNull()
    expect(deriveSessionTitle('   ')).toBeNull()
    expect(deriveSessionTitle('@前端工程师')).toBeNull()
  })
})

describe('isPlaceholderSessionTitle', () => {
  it('recognizes system placeholders only', () => {
    expect(isPlaceholderSessionTitle('新会话')).toBe(true)
    expect(isPlaceholderSessionTitle('新项目')).toBe(true)
    expect(isPlaceholderSessionTitle('与 Orchestrator 对话')).toBe(true)
    expect(isPlaceholderSessionTitle('私聊: 前端工程师')).toBe(true)
    expect(isPlaceholderSessionTitle('私聊：后端工程师')).toBe(true)
    expect(isPlaceholderSessionTitle('')).toBe(true)
    expect(isPlaceholderSessionTitle(undefined)).toBe(false)
  })

  it('does not overwrite a user title', () => {
    expect(isPlaceholderSessionTitle('登录页重构')).toBe(false)
    expect(isPlaceholderSessionTitle('私聊记录')).toBe(false)
  })
})

describe('project labels', () => {
  it('normalizes Windows and POSIX paths', () => {
    expect(normalizeProjectDir(' D:\\work\\alpha\\ ')).toBe('D:/work/alpha')
    expect(normalizeProjectDir('/home/me/alpha/')).toBe('/home/me/alpha')
    expect(getProjectLabel('D:\\work\\alpha')).toBe('alpha')
    expect(getProjectLabel('')).toBe('未绑定项目')
  })

  it('labels session types', () => {
    expect(getSessionTypeLabel('group')).toBe('群聊')
    expect(getSessionTypeLabel('private')).toBe('私聊')
    expect(getSessionTypeLabel('orchestrator')).toBe('Orchestrator')
    expect(getSessionTypeLabel(undefined)).toBe('会话')
  })
})

describe('filterSessions', () => {
  it('matches title, project path, member name and type', () => {
    const sessions = [
      session({
        id: 's1', title: '登录页', projectDir: 'D:/work/shop', updatedAt: '2026-11-04T10:00:00.000Z',
        members: [{ agentId: 'a1', agent: { name: '前端工程师' } }],
      }),
      session({ id: 's2', title: '支付回调', type: 'private', updatedAt: '2026-11-04T09:00:00.000Z' }),
    ]

    expect(filterSessions(sessions, '登录').map(s => s.id)).toEqual(['s1'])
    expect(filterSessions(sessions, 'shop').map(s => s.id)).toEqual(['s1'])
    expect(filterSessions(sessions, '前端').map(s => s.id)).toEqual(['s1'])
    expect(filterSessions(sessions, '私聊').map(s => s.id)).toEqual(['s2'])
    expect(filterSessions(sessions, '')).toHaveLength(2)
  })
})

describe('groupSessions', () => {
  const now = new Date(2026, 10, 4, 12, 0, 0) // 2026-11-04 12:00 local

  it('groups by calendar day and keeps pinned sessions separate', () => {
    const sessions = [
      session({ id: 'p', title: '置顶', updatedAt: new Date(2026, 9, 20, 12).toISOString(), isPinned: true }),
      session({ id: 't', title: '今天', updatedAt: new Date(2026, 10, 4, 9).toISOString() }),
      session({ id: 'y', title: '昨天', updatedAt: new Date(2026, 10, 3, 9).toISOString() }),
      session({ id: 'w', title: '本周', updatedAt: new Date(2026, 9, 31, 9).toISOString() }),
      session({ id: 'o', title: '更早', updatedAt: new Date(2026, 9, 1, 9).toISOString() }),
    ]

    const groups = groupSessions(sessions, 'time', now)
    expect(groups.map(g => g.label)).toEqual(['置顶', '今天', '昨天', '本周', '更早'])
    expect(groups[0].sessions.map(s => s.id)).toEqual(['p'])
  })

  it('groups by projectDir case-insensitively and sorts by latest activity', () => {
    const sessions = [
      session({ id: 'a1', title: 'A1', projectDir: 'D:\\work\\Alpha', updatedAt: new Date(2026, 10, 4, 9).toISOString() }),
      session({ id: 'a2', title: 'A2', projectDir: 'd:/work/alpha/', updatedAt: new Date(2026, 10, 4, 10).toISOString() }),
      session({ id: 'b1', title: 'B1', projectDir: '/home/me/beta', updatedAt: new Date(2026, 10, 3, 9).toISOString() }),
      session({ id: 'u1', title: 'U1', updatedAt: new Date(2026, 10, 2, 9).toISOString() }),
    ]

    const groups = groupSessions(sessions, 'project', now)
    expect(groups.map(g => g.label)).toEqual(['alpha', 'beta', '未绑定项目'])
    expect(groups[0].sessions.map(s => s.id)).toEqual(['a2', 'a1'])
    expect(groups[2].sessions.map(s => s.id)).toEqual(['u1'])
  })

  it('returns no groups for an empty list', () => {
    expect(groupSessions([], 'time', now)).toEqual([])
  })
})

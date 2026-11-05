import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SessionHeader, formatElapsed, getStepIndex, type SessionHeaderProps } from '../src/components/session-header'

const counts = { total: 3, done: 1, running: 1, pending: 1, failed: 0 }

const render = (overrides: Partial<SessionHeaderProps> = {}) => renderToStaticMarkup(createElement(SessionHeader, {
  sessionType: 'group',
  phase: 'alignment',
  phaseStep: 'pm_confirm',
  projectDir: 'D:\\projects\\demo',
  permissionMode: 'default',
  pendingPermissionCount: 0,
  taskCounts: counts,
  loading: false,
  onStop: () => {},
  onCopyProjectDir: () => {},
  ...overrides,
}))

describe('getStepIndex', () => {
  it('maps real phase/phaseStep to the four-step progress', () => {
    expect(getStepIndex('idle')).toBe(-1)
    expect(getStepIndex('alignment', 'pm_confirm')).toBe(0)
    expect(getStepIndex('alignment', 'architect_plan')).toBe(1)
    expect(getStepIndex('alignment', 'agent_qa')).toBe(1)
    expect(getStepIndex('execution')).toBe(2)
    expect(getStepIndex('done')).toBe(3)
  })
})

describe('formatElapsed', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatElapsed(1_000, 1_000)).toBe('0:00')
    expect(formatElapsed(1_000, 66_000)).toBe('1:05')
    expect(formatElapsed(1_000, 3_666_000)).toBe('1:01:05')
    expect(formatElapsed(0, 90_061_000)).toBe('1天 01:01:01')
  })
})

describe('SessionHeader', () => {
  it('shows alignment step, project dir and permission mode', () => {
    const html = render()

    expect(html).toContain('群聊')
    expect(html).toContain('产品经理确认需求')
    expect(html).toContain('D:\\projects\\demo')
    expect(html).toContain('默认 · 需确认')
  })

  it('shows current agent/task and audit marker during execution', () => {
    const html = render({
      phase: 'execution',
      phaseStep: '',
      loading: true,
      currentTask: {
        description: '创建 convert.js',
        agentName: '后端工程师',
        startedAt: new Date().toISOString(),
      },
    })

    expect(html).toContain('后端工程师')
    expect(html).toContain('创建 convert.js')
    expect(html).toContain('每批审计')
    expect(html).toContain('停止')
  })

  it('shows completion summary and hides stop when done', () => {
    const html = render({
      phase: 'done',
      phaseStep: '',
      taskCounts: { total: 3, done: 3, running: 0, pending: 0, failed: 0 },
    })

    expect(html).toContain('已完成 · 3/3 个任务')
    expect(html).not.toContain('停止')
  })

  it('surfaces pending permission count and auto mode', () => {
    const html = render({ pendingPermissionCount: 2, permissionMode: 'auto' })

    expect(html).toContain('待批 2')
    expect(html).toContain('自动 · 免确认')
  })

  it('shows the system event entry when there are events', () => {
    const html = render({ systemEventCount: 3, onOpenSystemEvents: () => {} })

    expect(html).toContain('系统事件 3')
  })

  it('shows system checks separately from user tasks', () => {
    const html = render({
      phase: 'execution',
      taskCounts: { total: 2, done: 2, running: 0, pending: 0, failed: 0, system: 1 },
    })

    expect(html).toContain('任务 2/2')
    expect(html).toContain('系统校验 1')
    expect(html).toContain('等待系统校验 · 1 项')
  })

  it('shows session elapsed and the current waiting reason', () => {
    const html = render({
      phase: 'execution',
      loading: true,
      sessionStartedAt: new Date().toISOString(),
      waitingReason: '等待 CLI 输出',
      waitingSince: new Date().toISOString(),
    })

    expect(html).toContain('会话')
    expect(html).toContain('等待 CLI 输出')
  })
})

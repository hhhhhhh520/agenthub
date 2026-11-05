import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SystemEventNotice } from '../src/components/system-event-notice'
import type { SystemEvent } from '../src/lib/system-events'

const event = (overrides: Partial<SystemEvent> = {}): SystemEvent => ({
  id: 'e1',
  source: 'message',
  ts: '2026-11-04T10:00:00.000Z',
  kind: 'audit',
  severity: 'warn',
  title: '文件边界告警',
  summary: '本批修改了未声明文件 a.ts',
  detail: '本批修改了未声明文件 a.ts，请人工确认',
  raw: '[越界警告] 本批修改了未声明文件 a.ts',
  agent: 'Orchestrator',
  ...overrides,
})

const render = (events: SystemEvent[]) => renderToStaticMarkup(createElement(SystemEventNotice, {
  events,
  onOpen: () => {},
}))

describe('SystemEventNotice', () => {
  it('renders a single event compactly', () => {
    const html = render([event()])

    expect(html).toContain('文件边界告警')
    expect(html).toContain('本批修改了未声明文件 a.ts')
    expect(html).toContain('查看详情')
  })

  it('renders a grouped count and the latest title', () => {
    const html = render([
      event(),
      event({ id: 'e2', kind: 'schema', title: '产物校验告警', summary: 'JSON 解析失败' }),
    ])

    expect(html).toContain('系统事件 · 2 条')
    expect(html).toContain('产物校验告警')
    expect(html).toContain('查看全部')
  })

  it('marks historical events explicitly', () => {
    const html = render([event({
      historical: true,
      summary: '历史记录，规则已更新：当前规则为共享项目目录不自动删除',
    })])

    expect(html).toContain('历史记录')
  })

  it('renders nothing without events', () => {
    expect(render([])).toBe('')
  })
})

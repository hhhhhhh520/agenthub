import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TaskCard } from '../src/components/task-card'
import { formatTraceEntry } from '../src/components/task-trace-dialog'
import type { TaskBoardTask } from '../src/lib/task-board'

const task = (overrides: Partial<TaskBoardTask> = {}): TaskBoardTask => ({
  id: 't1',
  description: '创建 convert.js，实现摄氏度转华氏度的函数并导出',
  status: 'pending',
  dependencies: '[]',
  declaredFiles: '["convert.js"]',
  ...overrides,
})

const render = (props: Partial<Parameters<typeof TaskCard>[0]> = {}) => renderToStaticMarkup(createElement(TaskCard, {
  task: task(),
  traceCount: 2,
  expanded: false,
  onToggle: () => {},
  onOpenTrace: () => {},
  ...props,
}))

describe('TaskCard', () => {
  it('renders a compact title, status, agent and trace link', () => {
    const html = render({ agentName: '后端工程师' })

    expect(html).toContain('创建 convert.js')
    expect(html).toContain('后端工程师')
    expect(html).toContain('轨迹 2')
    expect(html).toContain('1 个文件')
    expect(html).not.toContain('声明文件')
  })

  it('renders the full description and declared files when expanded', () => {
    const html = render({ expanded: true })

    expect(html).toContain('声明文件')
    expect(html).toContain('convert.js')
  })

  it('renders system checks with a distinct label instead of the raw prompt', () => {
    const html = render({
      task: task({
        description: '[系统验证任务] 验证以下代码任务：\n- A\n- B',
        dependencies: '[]',
        declaredFiles: '[]',
      }),
      traceCount: 0,
    })

    expect(html).toContain('系统校验')
    expect(html).toContain('产出物验证 · 2 项')
    expect(html).not.toContain('[系统验证任务]')
  })

  it('shows a compact duration for completed tasks', () => {
    const html = render({
      task: task({
        status: 'completed',
        createdAt: '2026-11-04T10:00:00.000Z',
        updatedAt: '2026-11-04T10:02:03.000Z',
        trace: JSON.stringify([
          { ts: '2026-11-04T10:00:10.000Z', event: 'start' },
          { ts: '2026-11-04T10:02:03.000Z', event: 'success' },
        ]),
      }),
    })

    expect(html).toContain('耗时 1:53')
  })

  it('shows redo only for failed/blocked user tasks', () => {
    const failed = render({ task: task({ status: 'failed' }), onRedo: () => {} })
    expect(failed).toContain('重做')

    const completed = render({ task: task({ status: 'completed' }), onRedo: () => {} })
    expect(completed).not.toContain('重做')
  })
})

describe('formatTraceEntry', () => {
  it('formats common trace events for humans', () => {
    expect(formatTraceEntry({ event: 'start', agent: '前端工程师' })).toContain('开始执行')
    expect(formatTraceEntry({ event: 'success', duration_ms: 1200 })).toContain('完成 1200ms')
    expect(formatTraceEntry({ event: 'correction', attempt: 2, message: '补充测试' })).toContain('纠偏 #2: 补充测试')
    expect(formatTraceEntry({ event: 'error', message: 'boom' })).toContain('失败: boom')
    expect(formatTraceEntry({ event: 'custom', message: 'x' })).toContain('custom: x')
  })
})

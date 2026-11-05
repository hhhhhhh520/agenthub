import { describe, expect, it } from 'vitest'
import { collectSystemEvents, classifySystemMessage, groupMessagesForChat } from '../src/lib/system-events'

const message = (overrides: Partial<Parameters<typeof classifySystemMessage>[0]> = {}) => ({
  id: 'm1',
  role: 'orchestrator',
  rawContent: '',
  createdAt: '2026-11-04T10:00:00.000Z',
  ...overrides,
})

describe('classifySystemMessage', () => {
  it('classifies boundary audit warnings', () => {
    const event = classifySystemMessage(message({
      rawContent: '[越界警告] 本批修改了未声明文件：src/a.ts。共享项目目录不自动删除，请人工确认。',
    }))

    expect(event).toMatchObject({
      kind: 'audit',
      severity: 'warn',
      title: '文件边界告警',
    })
    expect(event?.summary).toContain('src/a.ts')
    expect(event?.summary).not.toContain('[越界警告]')
  })

  it('removes internal labels from the display detail but keeps them in raw', () => {
    const event = classifySystemMessage(message({
      rawContent: '[schema 警告] 产出末尾的 JSON 块解析失败',
    }))

    expect(event?.summary).toBe('产出末尾的 JSON 块解析失败')
    expect(event?.raw).toContain('[schema 警告]')
  })

  it('classifies schema, correction and audit failures', () => {
    expect(classifySystemMessage(message({
      rawContent: '[schema 警告] 产出末尾的 JSON 块解析失败',
    }))).toMatchObject({ kind: 'schema', severity: 'warn' })

    expect(classifySystemMessage(message({
      rawContent: 'Orchestrator 纠偏：请补充测试',
    }))).toMatchObject({ kind: 'correction', severity: 'warn' })

    expect(classifySystemMessage(message({
      rawContent: '[审计不可用] 本批开始前影子 git 快照失败',
    }))).toMatchObject({ kind: 'audit', severity: 'error' })
  })

  it('classifies replan and timeout messages', () => {
    expect(classifySystemMessage(message({
      rawContent: '[REPLAN]未能生成有效任务方案',
    }))).toMatchObject({ kind: 'replan', severity: 'warn' })

    expect(classifySystemMessage(message({
      rawContent: '[REPLAN-EXHAUSTED]连续 3 次未能生成有效任务方案',
    }))).toMatchObject({ kind: 'replan', severity: 'error' })

    expect(classifySystemMessage(message({
      rawContent: '执行阶段超时，已停止本轮执行',
    }))).toMatchObject({ kind: 'timeout', severity: 'error' })
  })

  it('classifies task failures and correction exhaustion', () => {
    expect(classifySystemMessage(message({
      rawContent: '任务 123e4567 失败: Agent 未返回有效内容',
    }))).toMatchObject({ kind: 'error', severity: 'error', title: '任务执行失败' })

    expect(classifySystemMessage(message({
      rawContent: '任务 "创建页面" 纠偏失败，已转人工',
    }))).toMatchObject({ kind: 'correction', severity: 'error', title: '纠偏熔断' })
  })

  it('does not classify normal completion or discussion summaries', () => {
    expect(classifySystemMessage(message({
      rawContent: '## ✅ 批次 1 任务完成报告\n\n已完成 convert.js',
    }))).toBeNull()

    expect(classifySystemMessage(message({
      rawContent: '[DISCUSSION_SUMMARY][STATUS:success]前端工程师：建议用 React',
    }))).toBeNull()
  })

  it('only classifies orchestrator messages', () => {
    expect(classifySystemMessage(message({
      role: 'agent',
      rawContent: '[越界警告] 这是 Agent 自己写的文本',
    }))).toBeNull()
  })

  it('marks legacy auto-clean warnings as historical without changing raw', () => {
    const event = classifySystemMessage(message({
      rawContent: '[越界警告] 任务 2ff40b83 创建了 1 个越界文件，已自动清理',
    }))

    expect(event?.historical).toBe(true)
    expect(event?.summary).toContain('历史记录，规则已更新')
    expect(event?.summary).toContain('共享项目目录不自动删除，请人工确认')
    expect(event?.detail).not.toBe(event?.raw)
    expect(event?.raw).toContain('已自动清理')
  })

  it('does not mark the current boundary warning as historical', () => {
    const event = classifySystemMessage(message({
      rawContent: '[越界警告] 本批修改了未声明文件：src/a.ts。共享项目目录不自动删除，请人工确认。',
    }))

    expect(event?.historical).toBeUndefined()
  })
})

describe('groupMessagesForChat', () => {
  const normal = message({ id: 'n1', rawContent: '任务完成，产出 convert.js' })
  const warning = message({ id: 'w1', rawContent: '[越界警告] 文件 a.ts' })
  const schema = message({ id: 'w2', rawContent: '[schema 警告] JSON 解析失败' })

  it('groups consecutive system events into one item', () => {
    const items = groupMessagesForChat([warning, schema, normal])

    expect(items).toHaveLength(2)
    expect(items[0].type).toBe('system')
    if (items[0].type === 'system') expect(items[0].events).toHaveLength(2)
    expect(items[1].type).toBe('message')
  })

  it('keeps system events in their timeline position', () => {
    const items = groupMessagesForChat([warning, normal, schema])

    expect(items.map(i => i.type)).toEqual(['system', 'message', 'system'])
  })

  it('returns messages only when there are no system events', () => {
    const items = groupMessagesForChat([normal])
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('message')
  })
})

describe('collectSystemEvents', () => {
  it('adds task trace errors and de-duplicates messages already in chat', () => {
    const audit = message({ id: 'w1', rawContent: '[越界警告] 文件 a.ts' })
    const tasks = [
      {
        id: 't1',
        createdAt: '2026-11-04T10:00:00.000Z',
        updatedAt: '2026-11-04T10:01:00.000Z',
        trace: JSON.stringify([
          { ts: '2026-11-04T10:00:30.000Z', event: 'error', message: '[越界警告] 文件 a.ts' },
          { ts: '2026-11-04T10:01:00.000Z', event: 'correction', message: '补充测试后重试' },
          { ts: '2026-11-04T10:01:01.000Z', event: 'success' },
        ]),
      },
    ]

    const events = collectSystemEvents([audit], tasks)

    expect(events).toHaveLength(2)
    expect(events[0].source).toBe('message')
    expect(events[1].source).toBe('task')
    expect(events[1].kind).toBe('correction')
  })

  it('ignores invalid task traces', () => {
    const events = collectSystemEvents([], [{ id: 't1', trace: 'not-json' }])
    expect(events).toEqual([])
  })
})

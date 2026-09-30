import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildChannelWhere, CHANNEL_ROLES } from '@/mcp-server/message-channel'

// ── ISSUE-028 T3：read_messages 频道过滤条件 ──
//
// 根因：旧实现 where role:'agent' 单角色过滤——盲测会话里消息全是 user/orchestrator
// 角色，工具恒返回「暂无消息」，orchestrator 据此声称"这是我们对话的第一条消息"（失忆）。
// 频道语义 = 会话全部协作发言（用户需求、Orchestrator 编排、Agent 产出），全角色可见。

describe('buildChannelWhere', () => {
  it('基础过滤：sessionId + 三角色 in 过滤（user/orchestrator/agent）', () => {
    expect(buildChannelWhere('s1')).toEqual({
      sessionId: 's1',
      role: { in: ['user', 'orchestrator', 'agent'] },
    })
  })

  it('since 提供 → 追加 createdAt > 边界（原行为保留）', () => {
    const where = buildChannelWhere('s1', '2026-09-30T00:00:00Z') as Record<string, unknown>
    expect(where.sessionId).toBe('s1')
    expect(where.role).toEqual({ in: ['user', 'orchestrator', 'agent'] })
    expect(where.createdAt).toEqual({ gt: new Date('2026-09-30T00:00:00Z') })
  })

  it('since 未提供 → 无 createdAt 键（findMany 全量取 50 条）', () => {
    const where = buildChannelWhere('s2') as Record<string, unknown>
    expect('createdAt' in where).toBe(false)
  })

  it('CHANNEL_ROLES 恰为三角色（防未来漏改）', () => {
    expect([...CHANNEL_ROLES]).toEqual(['user', 'orchestrator', 'agent'])
  })
})

// ── 接线守卫（源码断言式，沿用 claude-code-env-wiring 模式）──
// 变异（把 index.ts 的 handler 改回内联 role:'agent' 过滤）必然红。
const MCP_SRC = readFileSync(resolve(__dirname, '../src/mcp-server/index.ts'), 'utf-8')
const CHANNEL_SRC = readFileSync(resolve(__dirname, '../src/mcp-server/message-channel.ts'), 'utf-8')

describe('ISSUE-028 接线守卫：read_messages → buildChannelWhere', () => {
  it('mcp-server/index.ts 的 read_messages 走 buildChannelWhere(SESSION_ID, since)', () => {
    expect(MCP_SRC).toContain("from './message-channel'")
    expect(MCP_SRC).toContain('buildChannelWhere(SESSION_ID, since)')
    // 旧的单角色内联 where 构造必须消失（回归即红）；
    // 注意 post_message 创建消息用 role:'agent' 是合法生产代码，不可一刀切禁字符串
    expect(MCP_SRC).not.toMatch(/const where[^=]*=\s*\{\s*sessionId:\s*SESSION_ID,\s*role:\s*'agent'/)
  })

  it('message-channel.ts 的角色集合来自 CHANNEL_ROLES 单一来源', () => {
    expect(CHANNEL_SRC).toContain('in: [...CHANNEL_ROLES]')
  })
})

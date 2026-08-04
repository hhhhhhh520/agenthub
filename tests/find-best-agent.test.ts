/**
 * ISSUE-009 针对性测试：findBestAgent 角色匹配 fallback
 *
 * 背景：任务拆解的 assignedAgent 在 Agent 列表中不存在时，旧逻辑按索引轮询
 * (agents[index % agents.length]) 随机分配，导致角色错配。
 * 修复：findBestAgent 按任务描述关键词匹配最合适的 Agent，轮询仅作最后兜底。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/db', () => ({
  prisma: {},
}))

import { findBestAgent } from '@/lib/orchestrator/index'

const AGENTS = [
  { name: 'Orchestrator' },
  { name: '产品经理' },
  { name: '架构师' },
  { name: '前端工程师' },
  { name: '后端工程师' },
  { name: '测试工程师' },
]

describe('ISSUE-009: findBestAgent', () => {
  it('前端关键词（页面/按钮/样式/CSS/UI）→ 前端工程师', () => {
    expect(findBestAgent('修复登录页面的按钮样式', AGENTS)?.name).toBe('前端工程师')
    expect(findBestAgent('优化 CSS 布局', AGENTS)?.name).toBe('前端工程师')
    expect(findBestAgent('重构 UI 组件', AGENTS)?.name).toBe('前端工程师')
  })

  it('后端关键词（API/接口/数据库/脚本/Python）→ 后端工程师', () => {
    expect(findBestAgent('实现用户登录 API 接口', AGENTS)?.name).toBe('后端工程师')
    expect(findBestAgent('编写 Python 数据清洗脚本', AGENTS)?.name).toBe('后端工程师')
    expect(findBestAgent('优化数据库查询', AGENTS)?.name).toBe('后端工程师')
  })

  it('测试关键词（测试/验证/test）→ 测试工程师', () => {
    expect(findBestAgent('运行单元测试验证登录功能', AGENTS)?.name).toBe('测试工程师')
    expect(findBestAgent('write test cases for login', AGENTS)?.name).toBe('测试工程师')
  })

  it('架构关键词（架构/方案）→ 架构师', () => {
    expect(findBestAgent('评审系统架构', AGENTS)?.name).toBe('架构师')
    expect(findBestAgent('给出技术选型方案', AGENTS)?.name).toBe('架构师')
  })

  it('产品关键词（产品/需求/PRD）→ 产品经理', () => {
    expect(findBestAgent('整理产品需求文档', AGENTS)?.name).toBe('产品经理')
    expect(findBestAgent('review the PRD', AGENTS)?.name).toBe('产品经理')
  })

  it('关键词大小写不敏感', () => {
    expect(findBestAgent('PYTHON script for data pipeline', AGENTS)?.name).toBe('后端工程师')
  })

  it('多类别关键词时按规则优先级（前端先于后端）', () => {
    expect(findBestAgent('前端页面调用后端 API', AGENTS)?.name).toBe('前端工程师')
  })

  it('无匹配关键词返回 undefined（交给轮询兜底）', () => {
    expect(findBestAgent('订一杯奶茶', AGENTS)).toBeUndefined()
    expect(findBestAgent('', AGENTS)).toBeUndefined()
  })

  it('LLM 拆解输出 null/undefined/非字符串 description 不抛错（防任务静默丢失）', () => {
    // decomposeTasks 直接 map LLM JSON，description 可能为 null/缺失/数字
    expect(() => findBestAgent(null as unknown as string, AGENTS)).not.toThrow()
    expect(() => findBestAgent(undefined as unknown as string, AGENTS)).not.toThrow()
    expect(() => findBestAgent(42 as unknown as string, AGENTS)).not.toThrow()
    expect(findBestAgent(null as unknown as string, AGENTS)).toBeUndefined()
  })

  it('命中类别但列表中没有对应 Agent 时返回 undefined，不误派', () => {
    const noFrontend = AGENTS.filter(a => a.name !== '前端工程师')
    expect(findBestAgent('修改按钮颜色', noFrontend)).toBeUndefined()
  })
})

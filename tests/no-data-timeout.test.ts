/**
 * ISSUE-007 针对性测试：NO_DATA_TIMEOUT_MS 回归守卫
 *
 * 背景：原值 60s 对复杂代码生成过于激进——LLM thinking 阶段无 stdout 输出，
 * 60s 内后端工程师重写 235 行贪吃蛇时被误判 stalled，进程被杀、进度全丢。
 * 修复：60s → 3min（外层还有 orchestrator/timeout.ts 的 15min AGENT_TASK 兜底）。
 *
 * 行为级测试需要真实等待 3 分钟，不可行；此文件守护两个不变量：
 * 1. 常量不能退回 60s（回归守卫）
 * 2. 内层无数据超时必须小于外层任务超时（层级关系不能颠倒）
 */
import { describe, it, expect } from 'vitest'
import { NO_DATA_TIMEOUT_MS } from '@/lib/adapter/process-registry'
import { TIMEOUT } from '@/lib/orchestrator/timeout'

describe('ISSUE-007: NO_DATA_TIMEOUT_MS', () => {
  it('是 3 分钟——不允许退回会误杀复杂任务的 60s', () => {
    expect(NO_DATA_TIMEOUT_MS).toBe(3 * 60 * 1000)
  })

  it('大于 60s（旧值回归检测）', () => {
    expect(NO_DATA_TIMEOUT_MS).toBeGreaterThan(60 * 1000)
  })

  it('小于外层 AGENT_TASK 15min 兜底（内层先触发才有意义）', () => {
    expect(NO_DATA_TIMEOUT_MS).toBeLessThan(TIMEOUT.AGENT_TASK)
  })
})

import { describe, expect, it } from 'vitest'
import { isTaskList } from '../src/lib/tasks-payload'

// 期望值一律写字面量 true/false，不引用实现内部常量——
// 守卫被删或放宽时测试必须变红。

describe('isTaskList 载荷形状守卫', () => {
  it('正常数组放行（含空板）', () => {
    expect(isTaskList([])).toBe(true)
    expect(
      isTaskList([{ id: 'a', status: 'pending', description: 'x', assignedAgentId: 'g', dependencies: '[]' }]),
    ).toBe(true)
    expect(isTaskList([{ id: 'a', status: 'in_progress', trace: '[]' }])).toBe(true)
  })

  it('非数组一律拦截', () => {
    expect(isTaskList({})).toBe(false)
    expect(isTaskList(null)).toBe(false)
    expect(isTaskList(undefined)).toBe(false)
    expect(isTaskList('[]')).toBe(false)
    expect(isTaskList(42)).toBe(false)
  })

  it('[null] 与缺字段项拦截（整页接管的真凶）', () => {
    expect(isTaskList([null])).toBe(false)
    expect(isTaskList([{}])).toBe(false)
    expect(isTaskList([{ id: 'a' }])).toBe(false)
    expect(isTaskList([{ status: 'pending' }])).toBe(false)
    expect(isTaskList([{ id: 1, status: 'pending' }])).toBe(false)
    expect(isTaskList([{ id: 'a', status: 0 }])).toBe(false)
  })

  it('多余字段向前兼容，不误杀', () => {
    expect(isTaskList([{ id: 'a', status: 'completed', extra: { foo: 1 } }])).toBe(true)
  })
})

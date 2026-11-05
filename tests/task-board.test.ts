import { describe, expect, it } from 'vitest'
import {
  deriveTaskBatches,
  isSystemTask,
  parseDeclaredFiles,
  parseTaskDependencies,
  splitTaskBoard,
  summarizeTaskBoard,
  systemTaskTitle,
  taskDisplayTitle,
  type TaskBoardTask,
} from '../src/lib/task-board'

const task = (overrides: Partial<TaskBoardTask> & { id: string }): TaskBoardTask => ({
  description: overrides.id,
  status: 'pending',
  dependencies: '[]',
  ...overrides,
})

describe('task-board helpers', () => {
  it('detects system verification tasks', () => {
    expect(isSystemTask('[系统验证任务] 验证以下代码任务')).toBe(true)
    expect(isSystemTask('  [系统验证任务] 验证以下代码任务')).toBe(true)
    expect(isSystemTask('创建 convert.js')).toBe(false)
  })

  it('builds a short title without protocol markers', () => {
    expect(taskDisplayTitle('[系统验证任务] 验证以下代码任务')).toBe('验证以下代码任务')

    const long = '创建 convert.js，实现摄氏度转华氏度的函数并导出，并补充测试用例，最后运行 node --test 验证'
    const title = taskDisplayTitle(long, 20)
    expect(title.length).toBeLessThanOrEqual(20)
    expect(title.endsWith('…')).toBe(true)
  })

  it('parses dependencies and declared files safely', () => {
    expect(parseTaskDependencies('["a","b"]')).toEqual(['a', 'b'])
    expect(parseTaskDependencies('not-json')).toEqual([])
    expect(parseTaskDependencies('{"a":1}')).toEqual([])
    expect(parseDeclaredFiles('["src/a.ts"]')).toEqual(['src/a.ts'])
    expect(parseDeclaredFiles(null)).toEqual([])
  })

  it('derives topological batches from dependencies', () => {
    const tasks = [
      task({ id: 'a', status: 'completed' }),
      task({ id: 'b', dependencies: '["a"]' }),
      task({ id: 'c' }),
      task({ id: 'd', dependencies: '["b","c"]' }),
    ]

    const batches = deriveTaskBatches(tasks)

    expect(batches.map(b => b.tasks.map(t => t.id))).toEqual([['a', 'c'], ['b'], ['d']])
  })

  it('fails open on cycles and missing dependencies', () => {
    const tasks = [
      task({ id: 'a', dependencies: '["b"]' }),
      task({ id: 'b', dependencies: '["a"]' }),
      task({ id: 'c', dependencies: '["missing"]' }),
    ]

    expect(() => deriveTaskBatches(tasks)).not.toThrow()
    expect(deriveTaskBatches(tasks).flatMap(b => b.tasks).map(t => t.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('keeps system tasks out of user batches and progress counts', () => {
    const tasks = [
      task({ id: 'a', status: 'completed' }),
      task({ id: 'b', status: 'failed' }),
      task({ id: 'sys', description: '[系统验证任务] 验证以下代码任务', status: 'pending' }),
    ]

    const { batches, systemTasks } = splitTaskBoard(tasks)
    const summary = summarizeTaskBoard(tasks)

    expect(batches.flatMap(b => b.tasks).map(t => t.id)).toEqual(['a', 'b'])
    expect(systemTasks.map(t => t.id)).toEqual(['sys'])
    expect(summary).toMatchObject({ total: 2, done: 1, failed: 1, system: 1 })
  })

  it('labels system checks by the number of verified items', () => {
    expect(systemTaskTitle('[系统验证任务] 验证：\n- A\n- B')).toBe('产出物验证 · 2 项')
    expect(systemTaskTitle('[系统验证任务] 验证：')).toBe('产出物验证')
  })
})

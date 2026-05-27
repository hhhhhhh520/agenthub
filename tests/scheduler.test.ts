import { describe, it, expect } from 'vitest'
import { topologicalSort, groupByBatch, enforceFileOverlap } from '../src/lib/orchestrator/scheduler'
import type { ScheduledTask } from '../src/lib/orchestrator/scheduler'

describe('topologicalSort', () => {
  it('should return tasks sorted by batch (no dependencies)', () => {
    const tasks: ScheduledTask[] = [
      { id: '1', description: 'Task 1', assignedAgent: 'agent1', dependencies: [], declaredFiles: [], batch: 0 },
      { id: '2', description: 'Task 2', assignedAgent: 'agent2', dependencies: [], declaredFiles: [], batch: 0 },
      { id: '3', description: 'Task 3', assignedAgent: 'agent3', dependencies: [], declaredFiles: [], batch: 0 },
    ]

    const result = topologicalSort(tasks)

    expect(result).toHaveLength(3)
    expect(result.every(t => t.batch === 0)).toBe(true)
  })

  it('should sort tasks with dependencies', () => {
    const tasks: ScheduledTask[] = [
      { id: '1', description: 'Task 1', assignedAgent: 'agent1', dependencies: [], declaredFiles: [], batch: 0 },
      { id: '2', description: 'Task 2', assignedAgent: 'agent2', dependencies: ['1'], declaredFiles: [], batch: 0 },
      { id: '3', description: 'Task 3', assignedAgent: 'agent3', dependencies: ['2'], declaredFiles: [], batch: 0 },
    ]

    const result = topologicalSort(tasks)

    expect(result[0].batch).toBe(0)
    expect(result[1].batch).toBe(1)
    expect(result[2].batch).toBe(2)
  })

  it('should handle parallel tasks with shared dependency', () => {
    const tasks: ScheduledTask[] = [
      { id: '1', description: 'Task 1', assignedAgent: 'agent1', dependencies: [], declaredFiles: [], batch: 0 },
      { id: '2', description: 'Task 2', assignedAgent: 'agent2', dependencies: ['1'], declaredFiles: [], batch: 0 },
      { id: '3', description: 'Task 3', assignedAgent: 'agent3', dependencies: ['1'], declaredFiles: [], batch: 0 },
      { id: '4', description: 'Task 4', assignedAgent: 'agent4', dependencies: ['2', '3'], declaredFiles: [], batch: 0 },
    ]

    const result = topologicalSort(tasks)

    expect(result[0].id).toBe('1')
    expect(result[0].batch).toBe(0)

    // Task 2 and 3 should both be batch 1 (parallel)
    const batch1Tasks = result.filter(t => t.batch === 1)
    expect(batch1Tasks).toHaveLength(2)

    // Task 4 should be batch 2
    expect(result.find(t => t.id === '4')?.batch).toBe(2)
  })

  it('should throw on circular dependency', () => {
    const tasks: ScheduledTask[] = [
      { id: '1', description: 'Task 1', assignedAgent: 'agent1', dependencies: ['2'], declaredFiles: [], batch: 0 },
      { id: '2', description: 'Task 2', assignedAgent: 'agent2', dependencies: ['1'], declaredFiles: [], batch: 0 },
    ]

    expect(() => topologicalSort(tasks)).toThrow(/Circular dependency/)
  })

  it('should handle complex dependency chain', () => {
    const tasks: ScheduledTask[] = [
      { id: 'A', description: 'A', assignedAgent: 'agent1', dependencies: [], declaredFiles: [], batch: 0 },
      { id: 'B', description: 'B', assignedAgent: 'agent2', dependencies: ['A'], declaredFiles: [], batch: 0 },
      { id: 'C', description: 'C', assignedAgent: 'agent3', dependencies: ['A'], declaredFiles: [], batch: 0 },
      { id: 'D', description: 'D', assignedAgent: 'agent4', dependencies: ['B', 'C'], declaredFiles: [], batch: 0 },
      { id: 'E', description: 'E', assignedAgent: 'agent5', dependencies: ['D'], declaredFiles: [], batch: 0 },
      { id: 'F', description: 'F', assignedAgent: 'agent6', dependencies: ['D'], declaredFiles: [], batch: 0 },
      { id: 'G', description: 'G', assignedAgent: 'agent7', dependencies: ['E', 'F'], declaredFiles: [], batch: 0 },
    ]

    const result = topologicalSort(tasks)

    // Verify batches: A=0, B,C=1, D=2, E,F=3, G=4
    expect(result.find(t => t.id === 'A')?.batch).toBe(0)
    expect(result.filter(t => t.batch === 1)).toHaveLength(2)
    expect(result.find(t => t.id === 'D')?.batch).toBe(2)
    expect(result.filter(t => t.batch === 3)).toHaveLength(2)
    expect(result.find(t => t.id === 'G')?.batch).toBe(4)
  })

  it('should handle empty task list', () => {
    const result = topologicalSort([])
    expect(result).toHaveLength(0)
  })

  it('should handle single task', () => {
    const tasks: ScheduledTask[] = [
      { id: '1', description: 'Task 1', assignedAgent: 'agent1', dependencies: [], declaredFiles: [], batch: 0 },
    ]

    const result = topologicalSort(tasks)

    expect(result).toHaveLength(1)
    expect(result[0].batch).toBe(0)
  })
})

describe('groupByBatch', () => {
  it('should group tasks by batch number', () => {
    const tasks: ScheduledTask[] = [
      { id: '1', description: 'T1', assignedAgent: 'a1', dependencies: [], declaredFiles: [], batch: 0 },
      { id: '2', description: 'T2', assignedAgent: 'a2', dependencies: ['1'], declaredFiles: [], batch: 1 },
      { id: '3', description: 'T3', assignedAgent: 'a3', dependencies: ['1'], declaredFiles: [], batch: 1 },
      { id: '4', description: 'T4', assignedAgent: 'a4', dependencies: ['2', '3'], declaredFiles: [], batch: 2 },
    ]

    const batches = groupByBatch(tasks)

    expect(batches).toHaveLength(3)
    expect(batches[0]).toHaveLength(1)
    expect(batches[1]).toHaveLength(2)
    expect(batches[2]).toHaveLength(1)
  })

  it('should return empty array for no tasks', () => {
    const batches = groupByBatch([])
    expect(batches).toHaveLength(0)
  })

  it('should handle single batch', () => {
    const tasks: ScheduledTask[] = [
      { id: '1', description: 'T1', assignedAgent: 'a1', dependencies: [], declaredFiles: [], batch: 0 },
      { id: '2', description: 'T2', assignedAgent: 'a2', dependencies: [], declaredFiles: [], batch: 0 },
    ]

    const batches = groupByBatch(tasks)

    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(2)
  })
})

describe('enforceFileOverlap', () => {
  it('should not modify tasks with no file overlap', () => {
    const tasks: ScheduledTask[] = [
      { id: '1', description: 'T1', assignedAgent: 'a1', dependencies: [], declaredFiles: ['file1.ts'], batch: 0 },
      { id: '2', description: 'T2', assignedAgent: 'a2', dependencies: [], declaredFiles: ['file2.ts'], batch: 0 },
    ]

    const result = enforceFileOverlap(tasks)

    expect(result).toHaveLength(2)
    expect(result[0].dependencies).toHaveLength(0)
    expect(result[1].dependencies).toHaveLength(0)
  })

  it('should inject dependency for overlapping files', () => {
    const tasks: ScheduledTask[] = [
      { id: '1', description: 'T1', assignedAgent: 'a1', dependencies: [], declaredFiles: ['shared.ts'], batch: 0 },
      { id: '2', description: 'T2', assignedAgent: 'a2', dependencies: [], declaredFiles: ['shared.ts'], batch: 0 },
    ]

    const result = enforceFileOverlap(tasks)

    // Task 2 should now depend on Task 1 (sorted by batch)
    const task2 = result.find(t => t.id === '2')
    expect(task2?.dependencies).toContain('1')
  })

  it('should handle multiple file overlaps', () => {
    const tasks: ScheduledTask[] = [
      { id: '1', description: 'T1', assignedAgent: 'a1', dependencies: [], declaredFiles: ['a.ts', 'b.ts'], batch: 0 },
      { id: '2', description: 'T2', assignedAgent: 'a2', dependencies: [], declaredFiles: ['b.ts', 'c.ts'], batch: 0 },
      { id: '3', description: 'T3', assignedAgent: 'a3', dependencies: [], declaredFiles: ['c.ts'], batch: 0 },
    ]

    const result = enforceFileOverlap(tasks)

    // b.ts is shared by T1 and T2 → T2 depends on T1
    // c.ts is shared by T2 and T3 → T3 depends on T2
    const task2 = result.find(t => t.id === '2')
    const task3 = result.find(t => t.id === '3')

    expect(task2?.dependencies).toContain('1')
    expect(task3?.dependencies).toContain('2')
  })

  it('should not create circular dependencies', () => {
    // If T1 depends on T2 and they share a file, we should NOT add T2→T1
    const tasks: ScheduledTask[] = [
      { id: '1', description: 'T1', assignedAgent: 'a1', dependencies: ['2'], declaredFiles: ['shared.ts'], batch: 1 },
      { id: '2', description: 'T2', assignedAgent: 'a2', dependencies: [], declaredFiles: ['shared.ts'], batch: 0 },
    ]

    // This should NOT create a circular dependency
    const result = enforceFileOverlap(tasks)

    // T2 already comes before T1 (batch 0 < batch 1), so T1 already depends on T2
    // No new dependency should be needed
    expect(result.find(t => t.id === '1')?.dependencies).toContain('2')
    expect(result.find(t => t.id === '2')?.dependencies).toHaveLength(0)
  })

  it('should handle tasks with no declared files', () => {
    const tasks: ScheduledTask[] = [
      { id: '1', description: 'T1', assignedAgent: 'a1', dependencies: [], declaredFiles: [], batch: 0 },
      { id: '2', description: 'T2', assignedAgent: 'a2', dependencies: [], declaredFiles: [], batch: 0 },
    ]

    const result = enforceFileOverlap(tasks)

    expect(result).toHaveLength(2)
    expect(result[0].dependencies).toHaveLength(0)
    expect(result[1].dependencies).toHaveLength(0)
  })

  it('should handle single task', () => {
    const tasks: ScheduledTask[] = [
      { id: '1', description: 'T1', assignedAgent: 'a1', dependencies: [], declaredFiles: ['file.ts'], batch: 0 },
    ]

    const result = enforceFileOverlap(tasks)

    expect(result).toHaveLength(1)
    expect(result[0].dependencies).toHaveLength(0)
  })
})
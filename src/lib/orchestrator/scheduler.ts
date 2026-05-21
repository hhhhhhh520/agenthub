export interface ScheduledTask {
  id: string
  description: string
  assignedAgent: string
  dependencies: string[]
  declaredFiles: string[]
  batch: number
}

export function topologicalSort(tasks: ScheduledTask[]): ScheduledTask[] {
  const taskMap = new Map(tasks.map(t => [t.id, t]))
  const batches = new Map<string, number>()

  function getBatch(taskId: string): number {
    if (batches.has(taskId)) return batches.get(taskId)!
    const task = taskMap.get(taskId)
    if (!task) return 0

    if (task.dependencies.length === 0) {
      batches.set(taskId, 0)
      return 0
    }

    const maxDepBatch = Math.max(...task.dependencies.map(depId => getBatch(depId)))
    const batch = maxDepBatch + 1
    batches.set(taskId, batch)
    return batch
  }

  function hasCycle(taskId: string, visiting: Set<string>, visited: Set<string>): boolean {
    if (visiting.has(taskId)) return true
    if (visited.has(taskId)) return false
    visiting.add(taskId)
    const task = taskMap.get(taskId)
    if (task) {
      for (const dep of task.dependencies) {
        if (hasCycle(dep, visiting, visited)) return true
      }
    }
    visiting.delete(taskId)
    visited.add(taskId)
    return false
  }

  for (const task of tasks) {
    const visiting = new Set<string>()
    if (hasCycle(task.id, visiting, new Set())) {
      throw new Error(`Circular dependency detected involving task ${task.id}`)
    }
  }

  for (const task of tasks) {
    task.batch = getBatch(task.id)
  }

  return tasks.sort((a, b) => a.batch - b.batch)
}

export function groupByBatch(tasks: ScheduledTask[]): ScheduledTask[][] {
  const batches: ScheduledTask[][] = []
  for (const task of tasks) {
    while (batches.length <= task.batch) batches.push([])
    batches[task.batch].push(task)
  }
  return batches
}

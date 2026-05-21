export interface ScheduledTask {
  id: string
  description: string
  assignedAgent: string
  dependencies: string[]
  declaredFiles: string[]
  workspacePath?: string
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

export function enforceFileOverlap(tasks: ScheduledTask[]): ScheduledTask[] {
  if (tasks.length <= 1) return tasks

  // Build file -> taskIds map
  const fileToTasks = new Map<string, string[]>()
  for (const task of tasks) {
    for (const file of task.declaredFiles) {
      const normalized = file.replace(/\\/g, '/')
      if (!fileToTasks.has(normalized)) fileToTasks.set(normalized, [])
      fileToTasks.get(normalized)!.push(task.id)
    }
  }

  const taskMap = new Map(tasks.map(t => [t.id, t]))

  // For each file with overlapping tasks, inject serial dependencies
  let changed = false
  for (const [, taskIds] of fileToTasks) {
    if (taskIds.length <= 1) continue

    // Sort by batch number
    const sorted = taskIds
      .map(id => taskMap.get(id)!)
      .sort((a, b) => a.batch - b.batch)

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]
      const curr = sorted[i]

      // Skip if already depends (directly or transitively)
      if (dependsOn(curr.id, prev.id, taskMap)) continue

      // Check for potential cycle
      if (dependsOn(prev.id, curr.id, taskMap)) {
        console.warn(`Cannot inject dependency: ${curr.id} -> ${prev.id} would create cycle`)
        continue
      }

      // Inject dependency
      curr.dependencies.push(prev.id)
      changed = true
    }
  }

  // Re-sort if dependencies were injected
  return changed ? topologicalSort(tasks) : tasks
}

function dependsOn(taskId: string, depId: string, taskMap: Map<string, ScheduledTask>): boolean {
  const visited = new Set<string>()
  const queue = [taskId]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current === depId) return true
    if (visited.has(current)) continue
    visited.add(current)
    const task = taskMap.get(current)
    if (task) {
      queue.push(...task.dependencies)
    }
  }
  return false
}

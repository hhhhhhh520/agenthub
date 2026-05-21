import { mkdirSync, cpSync, readdirSync, statSync, existsSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join, relative } from 'path'

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'workspaces', '.claude'])
const SKIP_FILES = new Set(['dev.db', 'dev.db-journal', 'dev.db-wal'])

export const WORKSPACE_ROOT = join(process.cwd(), 'workspaces')

export function ensureWorkspaceRoot(): void {
  if (!existsSync(WORKSPACE_ROOT)) {
    mkdirSync(WORKSPACE_ROOT, { recursive: true })
  }
}

export function createTaskWorkspace(sessionId: string, taskId: string): string {
  const taskDir = join(WORKSPACE_ROOT, sessionId, `task-${taskId}`)
  mkdirSync(taskDir, { recursive: true })

  const projectRoot = process.cwd()
  cpSync(projectRoot, taskDir, {
    recursive: true,
    filter: (src) => {
      const name = src.split(/[/\\]/).pop() || ''
      if (SKIP_DIRS.has(name)) return false
      if (SKIP_FILES.has(name)) return false
      return true
    },
  })

  return taskDir
}

export function takeSnapshot(sessionId: string): string[] {
  const snapshotDir = join(WORKSPACE_ROOT, sessionId)
  mkdirSync(snapshotDir, { recursive: true })

  const files = getFileList(process.cwd())
  const snapshotPath = join(snapshotDir, '.snapshot.json')
  writeFileSync(snapshotPath, JSON.stringify(files), 'utf-8')
  return files
}

export function getFileList(dirPath: string): string[] {
  const files: string[] = []
  const projectRoot = process.cwd()

  function walk(dir: string) {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile()) {
        files.push(relative(projectRoot, fullPath).replace(/\\/g, '/'))
      }
    }
  }

  walk(dirPath)
  return files
}

export interface FileDiff {
  added: string[]
  removed: string[]
  modified: string[]
}

export function diffFileLists(before: string[], after: string[]): FileDiff {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)

  const added = after.filter(f => !beforeSet.has(f))
  const removed = before.filter(f => !afterSet.has(f))

  // Modified: exists in both but different mtime
  const modified: string[] = []
  const projectRoot = process.cwd()
  for (const f of after) {
    if (!beforeSet.has(f)) continue
    // We can't compare mtime here without the actual files, so we leave modified empty
    // The audit module will handle mtime comparison
  }

  return { added, removed, modified }
}

export interface AuditResult {
  declared: string[]
  undeclared: string[]
  unchanged: string[]
}

export function auditTaskWorkspace(sessionId: string, taskId: string, declaredFiles: string[]): AuditResult {
  const taskDir = join(WORKSPACE_ROOT, sessionId, `task-${taskId}`)
  const snapshotPath = join(WORKSPACE_ROOT, sessionId, '.snapshot.json')

  if (!existsSync(snapshotPath) || !existsSync(taskDir)) {
    return { declared: [], undeclared: [], unchanged: declaredFiles }
  }

  const snapshotFiles: string[] = JSON.parse(readFileSync(snapshotPath, 'utf-8'))
  const taskFiles = getFileList(taskDir)
  const projectRoot = process.cwd()

  // Find actually changed files by comparing mtime
  const changedFiles: string[] = []
  for (const file of taskFiles) {
    const originalPath = join(projectRoot, file)
    const taskPath = join(taskDir, file)

    if (!existsSync(originalPath)) {
      // New file created by agent
      changedFiles.push(file)
    } else {
      const originalStat = statSync(originalPath)
      const taskStat = statSync(taskPath)
      if (taskStat.mtimeMs > originalStat.mtimeMs) {
        changedFiles.push(file)
      }
    }
  }

  // Check for deleted files
  for (const file of snapshotFiles) {
    if (!existsSync(join(taskDir, file)) && existsSync(join(projectRoot, file))) {
      changedFiles.push(file)
    }
  }

  const declaredSet = new Set(declaredFiles.map(f => f.replace(/\\/g, '/')))
  const declared = changedFiles.filter(f => declaredSet.has(f))
  const undeclared = changedFiles.filter(f => !declaredSet.has(f))
  const unchanged = declaredFiles.filter(f => !changedFiles.includes(f))

  return { declared, undeclared, unchanged }
}

export function cleanupTaskWorkspaces(sessionId: string): void {
  const sessionDir = join(WORKSPACE_ROOT, sessionId)
  if (!existsSync(sessionDir)) return

  const entries = readdirSync(sessionDir)
  for (const entry of entries) {
    if (entry.startsWith('task-') || entry === '.snapshot.json') {
      rmSync(join(sessionDir, entry), { recursive: true, force: true })
    }
  }
}

import { execSync } from 'child_process'

export function getChangedFiles(projectDir: string, before: Set<string>): string[] {
  try {
    const after = execSync('git diff --name-only HEAD', { cwd: projectDir, encoding: 'utf-8', timeout: 5000 })
      .trim().split('\n').filter(Boolean)
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: projectDir, encoding: 'utf-8', timeout: 5000 })
      .trim().split('\n').filter(Boolean)
    const all = new Set([...after, ...untracked])
    return [...all].filter(f => !before.has(f))
  } catch {
    return []
  }
}

export function getGitSnapshot(projectDir: string): Set<string> {
  try {
    const tracked = execSync('git diff --name-only HEAD', { cwd: projectDir, encoding: 'utf-8', timeout: 5000 })
      .trim().split('\n').filter(Boolean)
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: projectDir, encoding: 'utf-8', timeout: 5000 })
      .trim().split('\n').filter(Boolean)
    return new Set([...tracked, ...untracked])
  } catch {
    return new Set()
  }
}

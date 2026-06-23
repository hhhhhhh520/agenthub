import { resolve, sep } from 'path'
import { realpathSync } from 'fs'

/**
 * 检查文件路径是否在项目目录内（防止路径遍历攻击）
 * 从 mcp-server/index.ts 提取，供测试和 MCP server 共用
 */
export function isPathSafe(filePath: string, workDir: string): boolean {
  const resolvedWorkDir = resolve(workDir)
  let realWorkDir: string
  try {
    realWorkDir = realpathSync(resolvedWorkDir)
  } catch {
    realWorkDir = resolvedWorkDir
  }

  try {
    const realPath = realpathSync(resolve(resolvedWorkDir, filePath))
    return realPath === realWorkDir || realPath.startsWith(realWorkDir + sep)
  } catch {
    // realpathSync throws if file doesn't exist; resolve+startsWith correctly handles
    // .. (e.g. `../etc/passwd` resolves outside workDir → rejected) but cannot detect
    // symlinks in the path. Symlink-based bypass requires an attacker (typically an
    // agent) to have already created a symlink inside workDir pointing outside —
    // agent-augmented attack, not direct external attack. Tightening this requires
    // realpathSync on dirname(resolved) to verify the parent dir is inside workDir.
    const resolved = resolve(resolvedWorkDir, filePath)
    return resolved === resolvedWorkDir || resolved.startsWith(resolvedWorkDir + sep)
  }
}

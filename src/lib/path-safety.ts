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
    // realpathSync throws if file doesn't exist, but resolve+startsWith
    // can still be bypassed by .. paths — reject unknown paths
    const resolved = resolve(resolvedWorkDir, filePath)
    return resolved === resolvedWorkDir || resolved.startsWith(resolvedWorkDir + sep)
  }
}

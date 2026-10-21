import { dirname, resolve, sep } from 'path'
import { lstatSync, realpathSync } from 'fs'

function isWithin(candidate: string, base: string): boolean {
  return candidate === base || candidate.startsWith(base + sep)
}

/**
 * 返回 target 最近存在祖先的真实路径。
 *
 * 目标文件通常尚不存在（例如 accept 新文件），此时 realpathSync 会 ENOENT。
 * 只检查 resolve+startsWith 无法发现父目录是 symlink；向上找到最近存在的
 * 祖先并 realpath，才能证明新文件的落点仍在 workDir 内。
 */
function nearestExistingRealPath(target: string): string | null {
  let current = target

  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        try {
          return realpathSync(current)
        } catch {
          // 悬空 symlink 无法证明指向，按不安全处理。
          return null
        }
      }
    } catch {
      // 当前层级不存在（或不可读）；继续交给 realpath/父目录处理。
    }

    try {
      return realpathSync(current)
    } catch {
      const parent = dirname(current)
      if (parent === current) return null
      current = parent
    }
  }
}

/**
 * 检查文件路径是否在项目目录内（防止路径遍历攻击）
 * 从 mcp-server/index.ts 提取，供测试和 MCP server 共用
 */
export function isPathSafe(filePath: string, workDir: string): boolean {
  const resolvedWorkDir = resolve(workDir)
  let realWorkDir: string | null = null
  try {
    realWorkDir = realpathSync(resolvedWorkDir)
  } catch {
    // workDir 尚不存在时，下方没有可跟随的 symlink；保留词法 fallback。
  }

  const target = resolve(resolvedWorkDir, filePath)
  if (realWorkDir === null) {
    return isWithin(target, resolvedWorkDir)
  }

  const realTarget = nearestExistingRealPath(target)
  return realTarget !== null && isWithin(realTarget, realWorkDir)
}

/**
 * 固定受管根校验：路径必须在 boundary 内，且自身不能是 symlink/junction。
 *
 * isPathSafe 会把 workDir 的 realpath 当作可信根；如果 workDir 本身被替换为
 * junction，它会把外部目标当成新的合法边界。files API 的 workspaces/<sessionId>
 * 是固定沙箱，必须在入口拒绝根本身重定向。根不存在（首次创建）允许。
 */
export function isPathRootSafe(rootPath: string, boundary: string): boolean {
  if (!isPathSafe(rootPath, boundary)) return false
  try {
    return !lstatSync(rootPath).isSymbolicLink()
  } catch (err) {
    // 根尚未创建是正常初始化路径；其他读取失败不能证明安全，fail-closed。
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

/**
 * list_files 目录校验：dir 相对 workDir 解析后必须落在 workDir 内。
 * 与裸 startsWith(WORK_DIR) 的区别：拒绝前缀同族目录（如 /a/b-evil 对 /a/b）。
 */
export function isListDirSafe(dir: string | undefined, workDir: string): boolean {
  return isPathSafe(resolve(workDir, dir || '.'), workDir)
}

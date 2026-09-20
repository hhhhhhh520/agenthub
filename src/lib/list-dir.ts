import { readdirSync } from 'fs'
import { join, resolve } from 'path'
import { isListDirSafe } from './path-safety'

/**
 * 递归列举目录树，不跟进符号链接/junction（含其子孙）。
 * 注：readdirSync 的 recursive 模式会跟进 junction，泄漏沙箱外文件名，
 * 因此这里手动递归并在每一层跳过符号链接。
 * 返回形如 "[D] src" / "[F] src/app.ts" 的行数组（路径相对 rootDir）。
 */
export function listDirTree(rootDir: string): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    const entries = readdirSync(rel ? join(rootDir, rel) : rootDir, { withFileTypes: true })
    for (const d of entries) {
      if (d.isSymbolicLink()) continue
      const relPath = rel ? join(rel, d.name) : d.name
      out.push(`${d.isDirectory() ? '[D] ' : '[F] '}${relPath}`)
      if (d.isDirectory()) walk(relPath)
    }
  }
  walk('')
  return out
}

/**
 * list_files 工具主体：校验目录后递归列举。
 * 从 mcp-server/index.ts 提取，供测试与 MCP server 共用。
 */
export function listProjectFiles(dir: string | undefined, workDir: string): string {
  if (!isListDirSafe(dir, workDir)) return '错误：路径超出项目目录'
  try {
    return listDirTree(resolve(workDir, dir || '.')).join('\n') || '(空目录)'
  } catch (err) {
    return `列出失败: ${err}`
  }
}

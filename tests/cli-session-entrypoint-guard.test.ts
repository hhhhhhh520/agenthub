import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'

// roadmap §2.4 静态守卫：cliSessionId 失效必须走统一入口 invalidateCliSession
// （src/lib/services/cli-session.ts）。redo 路由 + execution.ts 曾散落 6 处
// `cliSessionId: null` 字面量（roadmap 附录 A 已核实），两表同写的事务语义靠人肉复制
// 已两次出过一致性风险（⚠️-C2 / F3 / F10）。本守卫锁定：src/lib/services 与
// src/app/api 下，该字面量只允许出现在统一入口自身；两个历史调用文件必须 import 它。

/** 递归收集目录下所有 .ts 文件的绝对路径 */
function walkTsFiles(root: URL): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const child = new URL(entry.name, root)
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(new URL(entry.name + '/', root)))
    } else if (entry.name.endsWith('.ts')) {
      out.push(fileURLToPath(child))
    }
  }
  return out
}

/** 取路径最后两段（跨平台），用于可读的断言输出 */
function tail2(p: string): string {
  return p.split(/[\\/]/).slice(-2).join('/')
}

describe('静态守卫 — cliSessionId 失效统一入口（roadmap §2.4）', () => {
  it('src/lib/services 与 src/app/api 下，cliSessionId: null 只允许出现在统一入口 cli-session.ts', () => {
    const roots = [
      new URL('../src/lib/services/', import.meta.url),
      new URL('../src/app/api/', import.meta.url),
    ]
    const hits: string[] = []
    for (const root of roots) {
      for (const file of walkTsFiles(root)) {
        const src = readFileSync(file, 'utf-8')
        if (/cliSessionId\s*:\s*null/.test(src)) hits.push(tail2(file))
      }
    }
    // 少于或多于这一处都红：前者说明统一入口被删，后者说明有人绕过入口写字面量
    expect(hits.sort()).toEqual(['services/cli-session.ts'])
  })

  it('execution.ts 与 redo/route.ts 都 import invalidateCliSession（统一入口接线）', () => {
    const execSrc = readFileSync(
      new URL('../src/lib/services/execution.ts', import.meta.url),
      'utf-8',
    )
    const redoSrc = readFileSync(
      new URL('../src/app/api/sessions/[id]/tasks/[taskId]/redo/route.ts', import.meta.url),
      'utf-8',
    )
    // execution.ts 同目录导入走 './' 惯例(与 ./shadow-git 等一致);redo 路由走 '@/' 别名
    for (const [name, src] of [['execution.ts', execSrc], ['redo/route.ts', redoSrc]] as const) {
      expect(
        src,
        `${name} 必须导入 invalidateCliSession`,
      ).toMatch(/import\s*\{[^}]*invalidateCliSession[^}]*\}\s*from\s*'(@\/lib\/services\/cli-session|\.\/cli-session)'/)
    }
  })
})

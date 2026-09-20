import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'

// roadmap §2.1 架构守卫：phase 字段只允许出现在 src/lib/orchestrator/state-machine.ts
// 的 prisma 写入中（当前唯一合法写点 state-machine.ts transitionPhase 的
// prisma.session.update —— 附录 A 已核实）。phase 写入散落到路由/服务层曾导致
// 写入竞态（ISSUE-022 同族风险），此后所有 phase 迁移必须经状态机。
//
// 两条断言互为犄角：
// ① 写点扫描——非 state-machine.ts 文件的 prisma.session 写调用参数文本中
//    不得出现 `phase:` 字面量（平衡括号提取调用文本，跳过字符串/注释防误配）；
// ② STATE_PHASE 守卫——状态机的 phase 写入表（Record<State, {phase, phaseStep}>）
//    不得被其他文件引用，堵"变量携带 phase 绕过字面量扫描"的写法。
//
// 静态守卫的已知盲区（2026-09-21 审查用 18 例变异探测确认，均无现役实例，
// 记录不追求完备——review 是最后防线，与项目既有源码守卫同一口径）：
// ① prisma.$executeRaw(Unsafe) 写 Session.phase（现役仅 PRAGMA/Config 表）
// ② 交互式事务 prisma.$transaction(async tx => tx.session.update(...))
//    ——tx 别名不命中正则（现役两处 $transaction 均数组式且不写 phase）
// ③ 别名导入 prisma as p / 方括号访问 prisma['session']（全仓惯例直引）
// ④ 变量携带 phase 对象传入 data（两个断言的正则面同样不可见）
// ⑤ 扫描范围仅 src/**.ts(x)：prisma/seed.ts、experiments/、scripts/ 不可见
// ⑥ 豁免是整文件级：state-machine.ts 内任何写都放行（现役仅 :254 经 STATE_PHASE）
// 已知误报向量（fail-noisy 方向，可接受）：callText 含字符串/注释原文，
// 字符串值里出现 `phase:` 会假阳性（如 data: { note: 'phase: x' }）；
// 参数内带撇号的正则字面量会使配对失败静默跳过（fail-open，静止守卫固有）。

const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url))
const LEGAL_FILE = join(SRC_ROOT, 'lib', 'orchestrator', 'state-machine.ts')

const SESSION_WRITE_RE =
  /prisma\s*\.\s*session\s*\.\s*(updateManyAndReturn|createManyAndReturn|updateMany|createMany|update|upsert|create)\b/g
const PHASE_KEY_RE = /\bphase\s*:/

function walkTs(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      // generated/ 是 prisma client 文档示例，不在守卫范围
      if (entry.name === 'generated') continue
      out.push(...walkTs(p))
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(p)
    }
  }
  return out
}

/**
 * 从 `(` 起提取平衡括号内的文本（含两端括号）。
 * 跳过字符串字面量（' " `）与注释（// /*），防字符串内的括号/`phase:` 干扰配对。
 */
function balancedParens(src: string, openIdx: number): string | null {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++
        i++
      }
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i++
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return src.slice(openIdx, i + 1)
    }
  }
  return null
}

describe('架构守卫 — phase 写入唯一性（roadmap §2.1）', () => {
  it('除 state-machine.ts 外，任何 prisma.session 写调用的参数文本不得含 phase 字面量', () => {
    const violations: string[] = []
    for (const file of walkTs(SRC_ROOT)) {
      if (file === LEGAL_FILE) continue
      const src = readFileSync(file, 'utf-8')
      for (const m of src.matchAll(SESSION_WRITE_RE)) {
        const callText = balancedParens(src, m.index + m[0].length)
        if (!callText) continue
        if (PHASE_KEY_RE.test(callText)) {
          violations.push(`${file}: ${m[0]}${callText.slice(0, 120)}`)
        }
      }
    }
    expect(violations, 'phase 写入只允许经 state-machine.ts；以下调用违规').toEqual([])
  })

  it('STATE_PHASE（状态机 phase 写入表）不得被 state-machine.ts 之外的文件引用', () => {
    const using: string[] = []
    for (const file of walkTs(SRC_ROOT)) {
      if (file === LEGAL_FILE) continue
      if (readFileSync(file, 'utf-8').includes('STATE_PHASE')) using.push(file)
    }
    expect(using, 'STATE_PHASE 只允许在 state-machine.ts 内使用').toEqual([])
  })
})

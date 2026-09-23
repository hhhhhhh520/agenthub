import { exec } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

/** ── §3.4 S3：preflight 命令红绿灯——纯层（2026-09-22 用户拍板 1A/2A/3A）──────────
 *
 * 1A 命令来源：约定探测项目 package.json 的 scripts.{test,build,lint}——命令永不来自 LLM，
 *    零 schema 变更；无 package.json / 无匹配脚本 → 弃权（同 S1 的 changedFiles 空守卫哲学）。
 * 2A 执行：`npm run <key>`（buildVerifyCommand 唯一构造点）——命令头与参数均由白名单常量
 *    构造，package.json 的 script 内容不进参数（由 npm 在其自身 shell 内执行，信任边界=
 *    项目作者，与"跑这个项目的 npm test"的 CI 常识一致）。Windows npm 为 .cmd shim 必须
 *    shell 执行（spawn shell:false 无法启动，2026-09-20 实测）——注入面由三层收口：
 *    来源钉死（1A）+ 键白名单（VERIFY_SCRIPT_KEYS）+ assertVerifyKey 运行时闸（fail-closed）。
 * 3A 失败语义：exit≠0 仅产出 outcome 供 execution.ts 记 Task.trace event:'preflight' 采数据，
 *    不纠偏不置 failed（误报率数据积累后由拍板决定是否升级）。
 *
 * 门控 EXPERIMENT_PREFLIGHT_VERIFY=on（严格相等，生产默认未设——roadmap §6 实验开关纪律，
 * 3 个月硬时限）。纯层不写库；trace 落库与纠偏决策在 execution.ts 接线（同段代码）。
 */

export function isPreflightVerifyOn(): boolean {
  return process.env.EXPERIMENT_PREFLIGHT_VERIFY === 'on'
}

/** 命令键白名单（命令头白名单的根基）——增删必须过审查（改动即执行面变化） */
export const VERIFY_SCRIPT_KEYS = ['test', 'build', 'lint'] as const
export type VerifyScriptKey = (typeof VERIFY_SCRIPT_KEYS)[number]

export type VerifyStatus = 'pass' | 'fail' | 'timeout' | 'error'

export interface VerifyOutcome {
  key: VerifyScriptKey
  status: VerifyStatus
  exitCode?: number
  durationMs: number
}

/** child_process.exec promisified 的形状（成功 resolve / 非零 reject，err 带 code/killed/signal） */
export type VerifyRunner = (cmd: string, cwd: string, timeoutMs: number) => Promise<{ stdout: string; stderr: string }>

export const VERIFY_TIMEOUT_MS = 120_000

/** 2A fail-closed 白名单闸：非白名单键一律 throw（防上游 JS 调用方绕过类型） */
export function assertVerifyKey(key: string): asserts key is VerifyScriptKey {
  if (!(VERIFY_SCRIPT_KEYS as readonly string[]).includes(key)) {
    throw new Error(`[preflight-verify] 非白名单验证键，拒绝执行: ${JSON.stringify(key)}（允许: ${VERIFY_SCRIPT_KEYS.join(', ')}）`)
  }
}

export function isVerifyKey(key: string): key is VerifyScriptKey {
  return (VERIFY_SCRIPT_KEYS as readonly string[]).includes(key)
}

/** 命令唯一构造点：`npm run <key>`——key 必须已过 assertVerifyKey */
export function buildVerifyCommand(key: VerifyScriptKey): string {
  assertVerifyKey(key)
  return `npm run ${key}`
}

/** 1A 约定探测：package.json scripts ∩ 白名单（按白名单序返回，非声明序）。
 *  无文件/损坏 JSON/scripts 非对象 → []（弃权，不穿透）。 */
export async function detectVerifyCommands(projectDir: string): Promise<VerifyScriptKey[]> {
  let scripts: unknown
  try {
    const raw = await readFile(join(projectDir, 'package.json'), 'utf8')
    scripts = (JSON.parse(raw) as { scripts?: unknown }).scripts
  } catch {
    return [] // 无 package.json 或损坏 → 弃权
  }
  if (typeof scripts !== 'object' || scripts === null) return []
  const record = scripts as Record<string, unknown>
  return VERIFY_SCRIPT_KEYS.filter(k => typeof record[k] === 'string' && (record[k] as string).length > 0)
}

const execAsync = promisify(exec) as (cmd: string, opts: { cwd: string; timeout: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>

/** exec 默认 maxBuffer=1MB——大输出套件（jest/vitest 全量）会以 ERR_CHILD_PROCESS_STDIO_MAXBUFFER
 *  reject（code 为字符串），被 outcome 映射误记成 error 污染采数（审查 🟡4a）。提至 10MB。 */
export const VERIFY_MAX_BUFFER = 10 * 1024 * 1024

/** 真 exec 执行器（可注入替代用于单测）。已知限制（审查 🟡4b）：timeout 杀的是直接子 shell，
 *  npm→node→runner 孙进程树可能残留（无 taskkill /T 整树语义）——实验臂知悉，转正前需收口。 */
export const defaultRunner: VerifyRunner = (cmd, cwd, timeoutMs) => execAsync(cmd, { cwd, timeout: timeoutMs, maxBuffer: VERIFY_MAX_BUFFER })

/** 执行全部验证键，逐键产出 outcome（前键红不阻断后键）。
 *  🔴 每键先过 assertVerifyKey（非白名单 → throw，runner 零调用——防线双保险）。
 *  映射：resolve → pass；reject 且 killed → timeout（不误记 fail）；
 *        reject 且 code 为数字 → fail(exitCode)；其余（spawn 级故障如 ENOENT）→ error。 */
export async function runVerifyCommands(
  projectDir: string,
  keys: readonly VerifyScriptKey[],
  runner: VerifyRunner = defaultRunner,
  timeoutMs: number = VERIFY_TIMEOUT_MS,
): Promise<VerifyOutcome[]> {
  const outcomes: VerifyOutcome[] = []
  for (const key of keys) {
    assertVerifyKey(key)
    const cmd = buildVerifyCommand(key)
    const t0 = Date.now()
    try {
      await runner(cmd, projectDir, timeoutMs)
      outcomes.push({ key, status: 'pass', durationMs: Date.now() - t0 })
    } catch (err) {
      const e = err as { code?: unknown; killed?: unknown }
      if (e.killed === true) {
        outcomes.push({ key, status: 'timeout', durationMs: Date.now() - t0 })
      } else if (typeof e.code === 'number') {
        outcomes.push({ key, status: 'fail', exitCode: e.code, durationMs: Date.now() - t0 })
      } else {
        outcomes.push({ key, status: 'error', durationMs: Date.now() - t0 })
      }
    }
  }
  return outcomes
}

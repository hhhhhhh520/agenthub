import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── §3.4 S3：preflight 命令红绿灯——纯层（2026-09-22 用户拍板 1A/2A/3A）──
//
// 1A 命令来源 = 约定探测 package.json scripts.{test,build,lint}（命令永不来自 LLM，零 schema 变更）
// 2A 执行 = npm run <key>（命令头/参数均由白名单常量构造，package.json 内容不进参数；
//          Windows npm .cmd shim 需 shell——安全面由"来源钉死 + 白名单 + assertVerifyKey"三层收口）
// 3A 失败语义 = 仅记 outcome 采数据，不纠偏（纠偏决策在 execution.ts 接线层，本文件不涉及）

import {
  isPreflightVerifyOn,
  VERIFY_SCRIPT_KEYS,
  isVerifyKey,
  assertVerifyKey,
  detectVerifyCommands,
  buildVerifyCommand,
  runVerifyCommands,
  VERIFY_TIMEOUT_MS,
  defaultRunner,
  type VerifyRunner,
} from '@/lib/services/preflight-verify'

describe('preflight 门控（EXPERIMENT_PREFLIGHT_VERIFY，F4 严格相等口径）', () => {
  const prev = process.env.EXPERIMENT_PREFLIGHT_VERIFY
  it('仅 "on" 激活（对齐 isStructuredMonitorOn/isSeqgateOn 先例）', () => {
    process.env.EXPERIMENT_PREFLIGHT_VERIFY = 'on'
    expect(isPreflightVerifyOn()).toBe(true)
    process.env.EXPERIMENT_PREFLIGHT_VERIFY = '1'
    expect(isPreflightVerifyOn()).toBe(false)
    process.env.EXPERIMENT_PREFLIGHT_VERIFY = 'true'
    expect(isPreflightVerifyOn()).toBe(false)
    delete process.env.EXPERIMENT_PREFLIGHT_VERIFY
    expect(isPreflightVerifyOn()).toBe(false)
  })
  it('用例结束恢复 env 原状', () => {
    if (prev === undefined) delete process.env.EXPERIMENT_PREFLIGHT_VERIFY
    else process.env.EXPERIMENT_PREFLIGHT_VERIFY = prev
    expect(true).toBe(true)
  })
})

describe('assertVerifyKey（2A fail-closed 白名单闸）', () => {
  it('白名单成员通过', () => {
    expect(() => assertVerifyKey('test')).not.toThrow()
    expect(() => assertVerifyKey('build')).not.toThrow()
    expect(() => assertVerifyKey('lint')).not.toThrow()
  })
  it('白名单外一律 throw（含 shell 注入形态与大小写变体）', () => {
    for (const bad of ['rm', 'test;rm', 'test && curl evil.sh', 'TEST', 'Test', '', 'test\nrm']) {
      expect(() => assertVerifyKey(bad), `应拒绝: ${JSON.stringify(bad)}`).toThrow()
    }
  })
  it('isVerifyKey 与 assertVerifyKey 同判定', () => {
    expect(isVerifyKey('test')).toBe(true)
    expect(isVerifyKey('rm')).toBe(false)
  })
  it('VERIFY_SCRIPT_KEYS 恰为固定三键（命令头白名单的根基，增删必须过审查）', () => {
    expect([...VERIFY_SCRIPT_KEYS]).toEqual(['test', 'build', 'lint'])
  })
  it('buildVerifyCommand 唯一构造点：npm run <key>', () => {
    expect(buildVerifyCommand('test')).toBe('npm run test')
  })
})

describe('detectVerifyCommands（1A 约定探测）', () => {
  let dir: string
  function makeProject(pkg: unknown | null): string {
    dir = mkdtempSync(join(tmpdir(), 'pf-verify-'))
    if (pkg !== null) writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg), 'utf8')
    return dir
  }

  it('scripts 有 test+lint → 按白名单顺序返回（非 scripts 声明序）', async () => {
    const d = makeProject({ name: 'x', scripts: { lint: 'eslint .', test: 'jest', build: 'tsc' } })
    await expect(detectVerifyCommands(d)).resolves.toEqual(['test', 'build', 'lint'])
  })
  it('无 package.json → []（弃权，同 S1 空守卫哲学）', async () => {
    const d = makeProject(null)
    await expect(detectVerifyCommands(d)).resolves.toEqual([])
  })
  it('package.json 损坏 → []（不穿透）', async () => {
    const d = mkdtempSync(join(tmpdir(), 'pf-verify-'))
    writeFileSync(join(d, 'package.json'), '{not json', 'utf8')
    await expect(detectVerifyCommands(d)).resolves.toEqual([])
  })
  it('scripts 缺键/空串 → 只返回存在的非空键', async () => {
    const d = makeProject({ scripts: { test: 'jest', build: '', lint: 42 as unknown as string } })
    await expect(detectVerifyCommands(d)).resolves.toEqual(['test'])
  })
  it('scripts 非对象 → []', async () => {
    const d = makeProject({ scripts: 'jest' })
    await expect(detectVerifyCommands(d)).resolves.toEqual([])
  })
})

describe('runVerifyCommands（outcome 映射 + fail-closed）', () => {
  const okRunner: VerifyRunner = async () => ({ stdout: 'ok', stderr: '' })
  function failRunner(code: number | undefined, killed = false): VerifyRunner {
    return async () => {
      const e = new Error('cmd failed') as Error & { code?: number; killed?: boolean }
      e.code = code
      e.killed = killed
      throw e
    }
  }

  it('exit 0 → pass', async () => {
    const out = await runVerifyCommands('D:/proj', ['test'], okRunner)
    expect(out).toEqual([{ key: 'test', status: 'pass', durationMs: expect.any(Number) }])
  })
  it('exit 1 → fail（3A：只记录，不抛不纠偏）', async () => {
    const out = await runVerifyCommands('D:/proj', ['test'], failRunner(1))
    expect(out).toEqual([{ key: 'test', status: 'fail', exitCode: 1, durationMs: expect.any(Number) }])
  })
  it('killed（超时被杀）→ timeout，不误记 fail', async () => {
    const out = await runVerifyCommands('D:/proj', ['test'], failRunner(undefined, true))
    expect(out).toEqual([{ key: 'test', status: 'timeout', durationMs: expect.any(Number) }])
  })
  it('spawn 级故障（无 code，如 ENOENT）→ error', async () => {
    const out = await runVerifyCommands('D:/proj', ['test'], failRunner(undefined, false))
    expect(out).toEqual([{ key: 'test', status: 'error', durationMs: expect.any(Number) }])
  })
  it('多键独立执行：前一键红不阻断后一键', async () => {
    let n = 0
    const runner: VerifyRunner = async () => { n++; if (n === 1) { const e = new Error('x') as Error & { code?: number }; e.code = 1; throw e } return { stdout: '', stderr: '' } }
    const out = await runVerifyCommands('D:/proj', ['test', 'lint'], runner)
    expect(out.map(o => o.status)).toEqual(['fail', 'pass'])
  })
  it('🔴 非白名单 key → throw 且 runner 零调用（防线即使上游漏校验也不执行）', async () => {
    let called = 0
    const spy: VerifyRunner = async () => { called++; return { stdout: '', stderr: '' } }
    await expect(runVerifyCommands('D:/proj', ['rm -rf /'] as never, spy)).rejects.toThrow()
    expect(called).toBe(0)
  })
  it('超时常量为正数且可导出（报告/接线回显用）', () => {
    expect(VERIFY_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('defaultRunner 2MB stdout 正常产出不误判（maxBuffer 审查 🟡4a：1MB 默认值会把大输出 pass 误成 error）', async () => {
    // 真 exec 集成点：node -e 输出 2MB 后 exit 0——maxBuffer=1MB 时 exec 以
    // ERR_CHILD_PROCESS_STDIO_MAXBUFFER reject（code 为字符串）→ 会被映射成 error 污染采数
    const dir = mkdtempSync(join(tmpdir(), 'pf-maxbuf-'))
    try {
      const out = await defaultRunner(
        `node -e "process.stdout.write('x'.repeat(2097152))"`,
        dir,
        30_000,
      )
      expect(out.stdout.length).toBe(2097152)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

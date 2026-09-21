import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, rmSync as realRmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { cleanupOrphanShadowGits } from '@/lib/services/shadow-git'

// roadmap §2.3: shadow-git 孤儿目录清扫。cleanupShadowGit 仅在 DELETE session
// 时按 sessionId 清理（sessions/[id]/route.ts），孤儿典型成因：DELETE 时清理
// 失败（warn 后继续删 session）且该 projectDir 仍被其他存活 session 引用。
// 覆盖面诚实口径（与实现注释一致）：session 还活着但目录位置漂移的场景
// （PUT 改走 projectDir / projectDir 被清空）id 命中 validIds 会被跳过、
// 旧 projectDir 不进 distinct 列表——那类需 DELETE/PUT 侧主动清，见待办。
// 本文件锁定孤儿扫描函数的契约。

// rmSync 走可控 passthrough mock：默认调用真实实现，best-effort 用例用
// mockImplementationOnce 注入单次失败（ESM 命名空间不可直接 spyOn）。
const { mockRmSync } = vi.hoisted(() => ({ mockRmSync: vi.fn() }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  mockRmSync.mockImplementation(actual.rmSync)
  return { ...actual, rmSync: mockRmSync }
})

describe('cleanupOrphanShadowGits — 孤儿影子 git 清扫', () => {
  let tmpRoot: string

  // 每用例独立 project root，防跨用例目录状态污染
  function newProject(): string {
    return join(tmpRoot, `proj-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  }

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'agenthub-orphan-'))
  })

  afterAll(() => {
    realRmSync(tmpRoot, { recursive: true, force: true })
  })

  it('无对应 session 的目录被删除，活跃 session 目录保留，返回已删除清单', () => {
    const root = newProject()
    mkdirSync(join(root, '.agenthub', 'shadow-git', 'session-alive'), { recursive: true })
    mkdirSync(join(root, '.agenthub', 'shadow-git', 'session-orphan-1'), { recursive: true })
    mkdirSync(join(root, '.agenthub', 'shadow-git', 'session-orphan-2'), { recursive: true })
    // 孤儿目录内有嵌套内容，验证 recursive 删除
    writeFileSync(join(root, '.agenthub', 'shadow-git', 'session-orphan-1', 'HEAD'), 'x')

    const removed = cleanupOrphanShadowGits(root, new Set(['session-alive']))

    expect(removed.sort()).toEqual(['session-orphan-1', 'session-orphan-2'])
    expect(existsSync(join(root, '.agenthub', 'shadow-git', 'session-alive'))).toBe(true)
    expect(existsSync(join(root, '.agenthub', 'shadow-git', 'session-orphan-1'))).toBe(false)
    expect(existsSync(join(root, '.agenthub', 'shadow-git', 'session-orphan-2'))).toBe(false)
  })

  it('shadow-git 根目录不存在时返回空数组且不抛错', () => {
    const missing = join(newProject(), 'no-such-project')
    expect(cleanupOrphanShadowGits(missing, new Set<string>())).toEqual([])
  })

  it('非目录条目（文件）跳过不删', () => {
    const root = newProject()
    mkdirSync(join(root, '.agenthub', 'shadow-git', 'stray-session'), { recursive: true })
    writeFileSync(join(root, '.agenthub', 'shadow-git', 'stray-file.txt'), 'x')

    const removed = cleanupOrphanShadowGits(root, new Set<string>())

    expect(removed).toEqual(['stray-session'])
    expect(existsSync(join(root, '.agenthub', 'shadow-git', 'stray-session'))).toBe(false)
    expect(existsSync(join(root, '.agenthub', 'shadow-git', 'stray-file.txt'))).toBe(true)
  })

  it('单目录删除失败不阻塞其余清理（best-effort）', () => {
    const root = newProject()
    mkdirSync(join(root, '.agenthub', 'shadow-git', 'fail-a'), { recursive: true })
    mkdirSync(join(root, '.agenthub', 'shadow-git', 'fail-b'), { recursive: true })

    // readdirSync 按字典序返回：fail-a 先删。首次 rmSync 注入失败，fail-b 正常 passthrough
    mockRmSync.mockImplementationOnce(() => {
      throw new Error('EBUSY: resource busy')
    })
    const removed = cleanupOrphanShadowGits(root, new Set<string>())

    expect(removed).toEqual(['fail-b'])
    expect(existsSync(join(root, '.agenthub', 'shadow-git', 'fail-a'))).toBe(true)
    expect(existsSync(join(root, '.agenthub', 'shadow-git', 'fail-b'))).toBe(false)
    // once 已消费，恢复 passthrough，清理残留
    realRmSync(join(root, '.agenthub', 'shadow-git', 'fail-a'), { recursive: true, force: true })
  })

  it('rootDir 本身是 junction/symlink 时整体跳过，不跟进目标（删除原语安全收口）', () => {
    // 攻击面（审查发现，对齐 list-dir.ts 先例）：.agenthub/shadow-git 若被替换成
    // junction，readdirSync 跟进目标 → 非uuid 名目录会被成批 rmSync——升级为
    // "启动时删任意目录树"。lstat 识别链接后必须整目录跳过。
    const victim = join(newProject(), 'victim-dir')
    mkdirSync(join(victim, 'real-orphan'), { recursive: true })
    const root = newProject()
    mkdirSync(join(root, '.agenthub'), { recursive: true })
    // Windows junction 免特权；POSIX 忽略 type 参数创建普通 symlink
    symlinkSync(victim, join(root, '.agenthub', 'shadow-git'), 'junction')

    const removed = cleanupOrphanShadowGits(root, new Set<string>())

    expect(removed).toEqual([])
    expect(existsSync(join(victim, 'real-orphan'))).toBe(true)
  })
})

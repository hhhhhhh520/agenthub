import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getGitSnapshot, getChangedFiles } from '../src/lib/services/shadow-git'

// 背景：execSync 模板串在命令串层存在注入机制（含 " 的 projectDir 可逃逸引号
// 执行任意命令——exec 层实测 canary 被写入）；端到端在 Windows 上被前置的
// fs.mkdirSync 闸住（" 是非法路径字符，先抛 ENOENT），POSIX 下可达。
// 本文件锁定：新实现（execFileSync 参数数组，无 shell）在元字符目录名下按
// 字面量正确工作；源码守卫是回退必红的唯一绊线。
describe('shadow-git — projectDir 含 shell 元字符（注入修复）', () => {
  let root: string
  const SID = 'test-session-inject'

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'agenthub-sg-')) + ' & echo injected'
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'a.txt'), 'x')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('影子仓库建在正确路径（git init 以字面量路径执行）', () => {
    getGitSnapshot(root, SID)
    expect(existsSync(join(root, '.agenthub', 'shadow-git', SID, 'HEAD'))).toBe(true)
  })

  it('新建文件能被快照捕获（diff/ls-files 路径未受元字符破坏）', () => {
    writeFileSync(join(root, 'new.txt'), 'x')
    const snap = getGitSnapshot(root, SID)
    expect(snap.has('new.txt')).toBe(true)
  })

  it('getChangedFiles 相对 before 快照返回新增文件', () => {
    const before = getGitSnapshot(root, SID)
    writeFileSync(join(root, 'b.txt'), 'x')
    const changed = getChangedFiles(root, SID, before)
    expect(changed).toContain('b.txt')
  })

  it('projectDir 为含双引号的注入串时不执行注入命令（canary 法）', () => {
    const canary = join(tmpdir(), `agenthub-canary-${Date.now()}.txt`)
    process.env.AGENTHUB_CANARY = canary
    // 注入机制在 exec 命令串层真实（exec 层实测 canary 被写入）；端到端在
    // Windows 被 mkdirSync 闸住。此用例锁定新实现下注入串只能作为 git 的
    // 字面量参数（fail-closed 抛错）、canary 永不写入。
    const malicious = join(tmpdir(), 'sg-nonexistent') + '" & node -e "require(\'fs\').writeFileSync(process.env.AGENTHUB_CANARY, \'pwned\')" & "'
    try {
      // 新实现：projectDir 含 " 是非法 Windows 路径 → git fail-closed 抛错（不再注入执行）
      expect(() => getGitSnapshot(malicious, 'test-session-pwn')).toThrow()
    } finally {
      delete process.env.AGENTHUB_CANARY
    }
    expect(existsSync(canary)).toBe(false)
  })

  it('源码守卫：shadow-git.ts 不得使用 execSync（模板串拼 shell）', () => {
    const src = readFileSync(new URL('../src/lib/services/shadow-git.ts', import.meta.url), 'utf-8')
    expect(src).not.toContain('execSync')
  })
})

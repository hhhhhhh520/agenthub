import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execSync } from 'child_process'

import {
  getGitSnapshot,
  getChangedFiles,
  cleanupShadowGit,
} from '@/lib/services/shadow-git'

/**
 * 影子 git 集成测试 — 用真实文件系统 + 真实 git。
 *
 * 核心验证:非 git 仓库的 workDir 也能正确追踪变更。
 * mock 单元测试覆盖不到。
 */
describe('shadow-git 集成测试', () => {
  let tmpRoot: string
  const TEST_SESSION = 'integ-test-session'

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-shadow-int-'))
  })

  afterEach(() => {
    try {
      cleanupShadowGit(tmpRoot, TEST_SESSION)
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {}
  })

  it('非 git 仓库 workDir 能追踪变更,且 workDir 不被 git init', () => {
    // 1. workDir 不是 git 仓库
    expect(fs.existsSync(path.join(tmpRoot, '.git'))).toBe(false)

    // 2. 写一个初始文件
    fs.writeFileSync(path.join(tmpRoot, 'existing.txt'), 'original content')

    // 3. 快照 — 影子 git 自动 init,commit 当前状态
    const before = getGitSnapshot(tmpRoot, TEST_SESSION)
    expect(before).toEqual(new Set())

    // 4. Agent 模拟: 新建 + 修改
    fs.writeFileSync(path.join(tmpRoot, 'new-file.txt'), 'agent wrote this')
    fs.writeFileSync(path.join(tmpRoot, 'existing.txt'), 'modified content')

    // 5. 获取变更 — 应该看到两个文件
    const changed = getChangedFiles(tmpRoot, TEST_SESSION, before)
    expect(changed).toContain('new-file.txt')
    expect(changed).toContain('existing.txt')
    expect(changed.length).toBe(2)

    // 6. workDir 本身没被 git init 污染
    expect(fs.existsSync(path.join(tmpRoot, '.git'))).toBe(false)

    // 7. 影子 git 元数据在 .agenthub/shadow-git/ 下
    const shadowDir = path.join(tmpRoot, '.agenthub/shadow-git', TEST_SESSION)
    expect(fs.existsSync(shadowDir)).toBe(true)
    expect(fs.existsSync(path.join(shadowDir, 'HEAD'))).toBe(true)
  })

  it('快照之间的增量计算正确(不误报已在 before 中的文件)', () => {
    const before = getGitSnapshot(tmpRoot, TEST_SESSION)

    fs.writeFileSync(path.join(tmpRoot, 'file-a.txt'), 'a')
    fs.writeFileSync(path.join(tmpRoot, 'file-b.txt'), 'b')

    const snapshot2 = getGitSnapshot(tmpRoot, TEST_SESSION)

    // 相对于初始 before,file-a 和 file-b 都是新增
    const changes1 = getChangedFiles(tmpRoot, TEST_SESSION, before)
    expect(changes1).toContain('file-a.txt')
    expect(changes1).toContain('file-b.txt')

    // 相对于 snapshot2,没有新增
    fs.writeFileSync(path.join(tmpRoot, 'file-c.txt'), 'c')
    const changes2 = getChangedFiles(tmpRoot, TEST_SESSION, snapshot2)
    expect(changes2).toEqual(['file-c.txt'])
  })

  it('影子 git 能读取 workDir 的 .gitignore(如果有)', () => {
    // workDir 里放一个 .gitignore
    fs.writeFileSync(path.join(tmpRoot, '.gitignore'), 'node_modules/\n')
    const before = getGitSnapshot(tmpRoot, TEST_SESSION)

    // Agent 在 node_modules/ 下写文件 — 没有被追踪
    fs.mkdirSync(path.join(tmpRoot, 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, 'node_modules', 'some-pkg.js'), 'ignored')

    // Agent 在 src/ 下写文件 — 正常追踪
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, 'src', 'index.ts'), 'real code')

    const changed = getChangedFiles(tmpRoot, TEST_SESSION, before)
    expect(changed).toEqual(['src/index.ts'])
    expect(changed).not.toContain('node_modules/some-pkg.js')
  })

  it('跨 session 影子 git 互相隔离(各自有独立的 commit 历史)', () => {
    const before1 = getGitSnapshot(tmpRoot, 'session-a')
    expect(before1).toEqual(new Set())

    // session A 的 Agent 创建文件 → 在 session A 的视图里是 changed
    fs.writeFileSync(path.join(tmpRoot, 'from-a.txt'), 'a')
    const changed1 = getChangedFiles(tmpRoot, 'session-a', before1)
    expect(changed1).toContain('from-a.txt')

    // session B 首次快照 — 影子 git 独立 init,**会把 from-a.txt 当作初始状态**
    // 因为 session B 的影子 git 第一次 commit 时,from-a.txt 已经存在
    const before2 = getGitSnapshot(tmpRoot, 'session-b')
    expect(before2).toEqual(new Set()) // session B 视角:基线已经包含 from-a.txt

    // session B 之后的修改才算变更
    fs.writeFileSync(path.join(tmpRoot, 'from-b.txt'), 'b')
    const changed2 = getChangedFiles(tmpRoot, 'session-b', before2)
    expect(changed2).toContain('from-b.txt')
    expect(changed2).not.toContain('from-a.txt') // 这才是隔离的真正含义

    // 验证两个影子目录独立存在
    expect(fs.existsSync(path.join(tmpRoot, '.agenthub/shadow-git/session-a'))).toBe(true)
    expect(fs.existsSync(path.join(tmpRoot, '.agenthub/shadow-git/session-b'))).toBe(true)

    // 清理
    cleanupShadowGit(tmpRoot, 'session-a')
    cleanupShadowGit(tmpRoot, 'session-b')
  })

  it('重复调用 cleanupShadowGit 幂等', () => {
    getGitSnapshot(tmpRoot, TEST_SESSION) // 创建影子 git
    cleanupShadowGit(tmpRoot, TEST_SESSION)
    cleanupShadowGit(tmpRoot, TEST_SESSION) // 第二次调用不应抛错
  })

  it('影子 git 在 `.agenthub/shadow-git/` 下,不污染 projectRoot', () => {
    getGitSnapshot(tmpRoot, TEST_SESSION)
    // 只有 .agenthub/shadow-git/ 这个目录
    const entries = fs.readdirSync(tmpRoot)
    // 忽略 .agenthub
    const onlyAgenthub = entries.filter(e => e !== '.agenthub')
    expect(onlyAgenthub.length).toBe(0) // 空的 workDir
  })

  // ❌-3 修复:防 .agenthub/ 被用户误提交进 git
  it('[❌-3] ensureShadowInit 后,projectRoot/.agenthub/.gitignore 存在且内容为 *', () => {
    getGitSnapshot(tmpRoot, TEST_SESSION)

    const gitignorePath = path.join(tmpRoot, '.agenthub', '.gitignore')
    expect(fs.existsSync(gitignorePath)).toBe(true)
    expect(fs.readFileSync(gitignorePath, 'utf-8')).toBe('*\n')
  })

  it('[❌-3] projectRoot 是 git 仓库时,.agenthub/ 不会出现在 user git status 中', () => {
    // 把 tmpRoot 初始化成真实 git 仓库
    execSync('git init', { cwd: tmpRoot, stdio: 'ignore' })
    execSync('git config user.email "test@example.com"', { cwd: tmpRoot, stdio: 'ignore' })
    execSync('git config user.name "test"', { cwd: tmpRoot, stdio: 'ignore' })
    fs.writeFileSync(path.join(tmpRoot, 'README.md'), 'init')
    execSync('git add . && git commit -m init', { cwd: tmpRoot, stdio: 'ignore' })

    // 跑影子 git
    getGitSnapshot(tmpRoot, TEST_SESSION)
    fs.writeFileSync(path.join(tmpRoot, 'work.txt'), 'agent output')

    // 用户视角 git status:work.txt 应可见,.agenthub/ 应被 .gitignore 忽略
    const userStatus = execSync('git status --porcelain', {
      cwd: tmpRoot, encoding: 'utf-8',
    })

    expect(userStatus).toMatch(/work\.txt/)
    expect(userStatus).not.toMatch(/\.agenthub/)
  })

  it('[❌-3] cleanupShadowGit 删除影子目录后,再调 getGitSnapshot 重新 init 仍正常', () => {
    getGitSnapshot(tmpRoot, TEST_SESSION)
    const shadowDir = path.join(tmpRoot, '.agenthub/shadow-git', TEST_SESSION)
    expect(fs.existsSync(shadowDir)).toBe(true)

    cleanupShadowGit(tmpRoot, TEST_SESSION)
    expect(fs.existsSync(shadowDir)).toBe(false)

    // 重新调,应该重新 init
    getGitSnapshot(tmpRoot, TEST_SESSION)
    expect(fs.existsSync(shadowDir)).toBe(true)
  })
}, 30_000)
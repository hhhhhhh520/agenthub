import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const SHADOW_GIT_REL = '.agenthub/shadow-git'

// ── 内部函数 ──

function getShadowDir(projectRoot: string, sessionId: string): string {
  return path.join(projectRoot, SHADOW_GIT_REL, sessionId)
}

/**
 * Build git --git-dir / --work-tree args for shadow git commands.
 * 路径作为独立参数传递（execFileSync 无 shell），天然兼容空格、中文与
 * shell 元字符（含双引号的注入串只会成为 git 的字面量参数），
 * 不存在模板串拼接的命令注入面。
 */
function gitArgs(shadowDir: string, workDir: string, ...rest: string[]): string[] {
  return ['--git-dir', shadowDir, '--work-tree', workDir, ...rest]
}

/** 同步执行 git（无 shell），非零退出抛错由调用方处理。 */
function gitSync(args: string[], timeoutMs: number, ignoreOutput = false): string {
  if (ignoreOutput) {
    execFileSync('git', args, { stdio: 'ignore', timeout: timeoutMs })
    return ''
  }
  return execFileSync('git', args, { encoding: 'utf-8', timeout: timeoutMs })
}

/**
 * 确保影子 git 仓库已初始化。
 * 幂等:第二次调用直接返回。
 *
 * 注意:当前仅在单线程顺序调用场景下使用(handleExecution while 循环内)。
 * 并发调用时存在 TOCTOU 竞态,但当前无此场景。
 *
 * ❌-3 修复:同时往 projectRoot/.agenthub/.gitignore 写自排除规则,
 * 避免用户的项目仓库 git status 看到 .agenthub/ 又误 git add 进库。
 */
function ensureShadowInit(shadowDir: string, workDir: string): void {
  // ❌-3 修复:无论 shadow 是否已 init,都确保 .agenthub/.gitignore 存在(幂等)
  // 这条放最前面,即使下面的 git init 已完成的"快路径"也要保证 .gitignore 写过
  ensureAgenthubGitignore(workDir)

  if (fs.existsSync(path.join(shadowDir, 'HEAD'))) return

  fs.mkdirSync(shadowDir, { recursive: true })
  gitSync(['init', '--bare', shadowDir], 10_000, true)

  // 排除影子 git 自身目录,避免 ls-files --others 误报。
  // info/exclude 是每个仓库的本地 ignore,不影响 workDir 自身的 .gitignore。
  const excludeFile = path.join(shadowDir, 'info', 'exclude')
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true })
  fs.writeFileSync(excludeFile, '.agenthub/\n', { encoding: 'utf-8' })

  gitSync(gitArgs(shadowDir, workDir, 'add', '-A'), 30_000, true)
  gitSync(gitArgs(shadowDir, workDir, 'commit', '-m', 'shadow init', '--allow-empty'), 10_000, true)
}

/**
 * ❌-3 修复:在 projectRoot/.agenthub/ 下写一个自排除 .gitignore。
 * 如果 projectRoot 是 git 仓库,用户 git status 不会显示 .agenthub/。
 * 内容 '*\n' 排除该目录下所有内容(整个 shadow-git 目录树)。
 *
 * 幂等:已存在内容相同则不写;已存在内容不同则覆盖(防外部脏写)。
 * 失败时静默忽略(写入 .gitignore 是 nice-to-have,不阻塞主流程)。
 */
function ensureAgenthubGitignore(workDir: string): void {
  try {
    const agenthubDir = path.join(workDir, '.agenthub')
    const gitignorePath = path.join(agenthubDir, '.gitignore')
    const expectedContent = '*\n'

    if (fs.existsSync(gitignorePath)) {
      const existing = fs.readFileSync(gitignorePath, 'utf-8')
      if (existing === expectedContent) return
    }

    fs.mkdirSync(agenthubDir, { recursive: true })
    fs.writeFileSync(gitignorePath, expectedContent, { encoding: 'utf-8' })
  } catch {
    // 写 .gitignore 失败不影响 shadow git 主功能
  }
}

// ── 公开 API ──

/**
 * 获取 workDir 当前"脏文件"集合:
 * - 被修改的已跟踪文件
 * - 未跟踪文件(按 .gitignore 排除)
 *
 * 相当于原 getGitSnapshot,但通过影子 git 实现,不依赖 workDir 自身的 git 状态。
 */
export function getGitSnapshot(projectRoot: string, sessionId: string): Set<string> {
  const shadowDir = getShadowDir(projectRoot, sessionId)
  ensureShadowInit(shadowDir, projectRoot)

  try {
    const modified = gitSync(gitArgs(shadowDir, projectRoot, 'diff', '--name-only', 'HEAD'), 10_000)
      .trim().split('\n').filter(Boolean)

    const untracked = gitSync(gitArgs(shadowDir, projectRoot, 'ls-files', '--others', '--exclude-standard'), 10_000)
      .trim().split('\n').filter(Boolean)

    return new Set([...modified, ...untracked])
  } catch (e) {
    // git 失败时(如工作目录过大导致超时),返回空集合让上层降级
    return new Set()
  }
}

/**
 * 获取自 `before` 快照以来新出现的脏文件。
 *
 * 相当于原 getChangedFiles,但通过影子 git 实现。
 */
export function getChangedFiles(
  projectRoot: string,
  sessionId: string,
  before: Set<string>,
): string[] {
  const shadowDir = getShadowDir(projectRoot, sessionId)
  ensureShadowInit(shadowDir, projectRoot)

  try {
    const modified = gitSync(gitArgs(shadowDir, projectRoot, 'diff', '--name-only', 'HEAD'), 10_000)
      .trim().split('\n').filter(Boolean)

    const untracked = gitSync(gitArgs(shadowDir, projectRoot, 'ls-files', '--others', '--exclude-standard'), 10_000)
      .trim().split('\n').filter(Boolean)

    const all = new Set([...modified, ...untracked])
    return [...all].filter(f => !before.has(f))
  } catch {
    return []
  }
}

/**
 * 清理某 session 的影子 git 元数据。幂等。
 */
export function cleanupShadowGit(projectRoot: string, sessionId: string): void {
  const shadowDir = getShadowDir(projectRoot, sessionId)
  if (fs.existsSync(shadowDir)) {
    fs.rmSync(shadowDir, { recursive: true, force: true })
  }
}

/**
 * 清扫 projectRoot 下无对应 session 的孤儿影子 git 目录（roadmap §2.3）。
 *
 * 覆盖面（诚实口径，与启动扫描 distinct projectDir 的机制一致）：只清
 * "session id 已失联（不在 validSessionIds）且该 projectDir 仍被 ≥1 个
 * 存活 session 引用"的孤儿——典型成因：DELETE 时 cleanupShadowGit 失败
 * （warn 后继续删 session）。清不了的（session 还活着但目录位置漂移，
 * PUT 改走 projectDir / projectDir 被清空后旧目录）：id 命中 validIds 被
 * 跳过，或旧 projectDir 不进 distinct 列表——需 DELETE/PUT 侧按旧
 * projectDir 主动清，见 PROGRESS 待办。
 *
 * validSessionIds 由调用方提供（全库 Session id 集合）——本模块保持纯 FS、
 * 无 DB 依赖。best-effort：单目录删除失败（占用/权限）不阻塞其余。
 */
export function cleanupOrphanShadowGits(projectRoot: string, validSessionIds: Set<string>): string[] {
  const rootDir = path.join(projectRoot, SHADOW_GIT_REL)
  if (!fs.existsSync(rootDir)) return []
  // 安全收口（对齐 list-dir.ts 的 junction 先例，这里是删除原语、危害更重）：
  // rootDir 本身若是符号链接/junction，readdirSync 会跟进目标——扫描+删除将
  // 作用于任意位置。lstat 不跟进链接，识别后整目录跳过。
  if (fs.lstatSync(rootDir).isSymbolicLink()) return []
  const removed: string[] = []
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (validSessionIds.has(entry.name)) continue
    try {
      fs.rmSync(path.join(rootDir, entry.name), { recursive: true, force: true })
      removed.push(entry.name)
    } catch {
      // 单目录失败跳过，不阻塞其余清理
    }
  }
  return removed
}

import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const SHADOW_GIT_REL = '.agenthub/shadow-git'

// ── 内部函数 ──

function getShadowDir(projectRoot: string, sessionId: string): string {
  return path.join(projectRoot, SHADOW_GIT_REL, sessionId)
}

/**
 * Build git --git-dir / --work-tree flags for shadow git commands.
 * 路径用双引号包裹,兼容空格和中文字符。
 */
function gitFlags(shadowDir: string, workDir: string): string {
  return `--git-dir="${shadowDir}" --work-tree="${workDir}"`
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
  execSync(`git init --bare "${shadowDir}"`, {
    encoding: 'utf-8', timeout: 10_000, stdio: 'ignore',
  })

  // 排除影子 git 自身目录,避免 ls-files --others 误报。
  // info/exclude 是每个仓库的本地 ignore,不影响 workDir 自身的 .gitignore。
  const excludeFile = path.join(shadowDir, 'info', 'exclude')
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true })
  fs.writeFileSync(excludeFile, '.agenthub/\n', { encoding: 'utf-8' })

  execSync(`git ${gitFlags(shadowDir, workDir)} add -A`, {
    encoding: 'utf-8', timeout: 30_000, stdio: 'ignore',
  })
  execSync(`git ${gitFlags(shadowDir, workDir)} commit -m "shadow init" --allow-empty`, {
    encoding: 'utf-8', timeout: 10_000, stdio: 'ignore',
  })
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
    const modified = execSync(`git ${gitFlags(shadowDir, projectRoot)} diff --name-only HEAD`, {
      encoding: 'utf-8', timeout: 10_000,
    }).trim().split('\n').filter(Boolean)

    const untracked = execSync(`git ${gitFlags(shadowDir, projectRoot)} ls-files --others --exclude-standard`, {
      encoding: 'utf-8', timeout: 10_000,
    }).trim().split('\n').filter(Boolean)

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
    const modified = execSync(`git ${gitFlags(shadowDir, projectRoot)} diff --name-only HEAD`, {
      encoding: 'utf-8', timeout: 10_000,
    }).trim().split('\n').filter(Boolean)

    const untracked = execSync(`git ${gitFlags(shadowDir, projectRoot)} ls-files --others --exclude-standard`, {
      encoding: 'utf-8', timeout: 10_000,
    }).trim().split('\n').filter(Boolean)

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
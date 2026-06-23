/**
 * Contract v1 §1.2 b: 敏感路径定义
 *
 * 越界修改敏感路径 → 任务硬失败,下游不启动。
 * 其他越界 → 软警告(由 execution.ts 处理)。
 *
 * 这套黑名单的设计原则:
 * - 改动会破坏全局依赖、配置、构建状态的文件
 * - 不应由"内容任务"误改的文件(`.env` 是部署边界,不是代码内容)
 * - 改坏后回滚成本高的文件(锁文件、schema)
 *
 * 如果架构师本来就拆了一个"改 package.json"的任务,只要它把该路径
 * 写进 declaredFiles,就不会被判越界。这是给"未声明的偷偷改"设的卡口。
 */

const SENSITIVE_EXACT = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'tsconfig.json',
  '.gitignore',
  'prisma/schema.prisma',
])

const SENSITIVE_PREFIX = [
  '.env',          // .env / .env.local / .env.production
  'node_modules/', // node_modules 下任何变更
  '.next/',        // build artifacts
  '.git/',         // 用户自己的 git 元数据(不是影子 git)
  '.agenthub/',    // AgentHub 私有目录(影子 git 等)
]

const SENSITIVE_PATTERNS = [
  /^next\.config\.[a-z]+$/,        // next.config.js / next.config.mjs / next.config.ts
  /^tsconfig\.[^.]+\.json$/,       // tsconfig.build.json 等
  /^vite\.config\.[a-z]+$/,
  /^vitest\.config\.[a-z]+$/,
  /^webpack\.config\.[a-z]+$/,
]

/**
 * 标准化路径用于匹配:统一斜杠、去前导 `./`、去结尾 `/`。
 */
function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
}

/**
 * 判断一个文件路径是否敏感(改动应硬失败)。
 *
 * @param filePath - 相对 workDir 的文件路径(git ls-files / git diff --name-only 的输出格式)
 */
export function isSensitivePath(filePath: string): boolean {
  const p = normalize(filePath)

  if (SENSITIVE_EXACT.has(p)) return true
  for (const prefix of SENSITIVE_PREFIX) {
    if (p === prefix.replace(/\/$/, '') || p.startsWith(prefix)) return true
  }
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(p)) return true
  }
  return false
}

/**
 * 从一组越界文件中筛出敏感越界。
 */
export function pickSensitive(undeclared: string[]): string[] {
  return undeclared.filter(isSensitivePath)
}

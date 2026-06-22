import { NextResponse } from 'next/server'
import { writeFile, mkdir, readFile } from 'fs/promises'
import { createHash } from 'crypto'
import { join, dirname, resolve } from 'path'
import { isPathSafe } from '@/lib/path-safety'
import { prisma } from '@/lib/db'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// 源码树/配置类敏感文件名：命中即拒。
// 匹配规则：part 等于敏感名，或以 `<敏感名>.` 开头（挡 .env.local 等变体），大小写不敏感。
const SENSITIVE_NAMES = [
  '.env', '.git', 'node_modules', '.next',
  '.github', '.vscode', '.idea', '.dockerignore',
  'Dockerfile', 'docker-compose',
  'package.json', 'package-lock.json',
  'next.config', 'tsconfig.json',
]

function isSensitivePath(normalizedPath: string): boolean {
  const parts = normalizedPath.toLowerCase().split('/')
  return parts.some(part => SENSITIVE_NAMES.some(name => part === name || part.startsWith(name + '.')))
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params
  const { filePath, content, target, force } = await request.json()

  if (!filePath || content === undefined) {
    return NextResponse.json({ error: 'filePath and content are required' }, { status: 400 })
  }

  if (typeof content === 'string' && content.length > 1024 * 1024) {
    return NextResponse.json({ error: 'File too large (max 1MB)' }, { status: 413 })
  }

  // #3: sessionId 必须是合法 UUID（挡 .. / / / \ 等路径注入）
  if (!UUID_RE.test(sessionId)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 })
  }

  // #4: target=project 写应用源码树 → 覆盖路由文件触发 Next 热重编译 → RCE。
  // 前端从不发送 target，该分支为死代码，直接禁用。
  if (target === 'project') {
    return NextResponse.json({ error: 'Writing to project source tree is disabled' }, { status: 403 })
  }

  // Normalize path
  const normalizedPath = filePath.replace(/\\/g, '/')

  // baseDir 永远是 workspace 沙箱（target=project 已在上拒绝）
  const baseDir = join(process.cwd(), 'workspaces', sessionId)

  // #3: 用 isPathSafe 替换原自证守卫（startsWith 无 sep 后缀，且 baseDir 被 sessionId 污染时自证无效）
  if (!isPathSafe(normalizedPath, baseDir)) {
    return NextResponse.json({ error: 'Invalid file path' }, { status: 400 })
  }

  // 拒绝指向 baseDir 本体的路径（'.' / './'），避免写目录
  if (resolve(baseDir, normalizedPath) === resolve(baseDir)) {
    return NextResponse.json({ error: 'Invalid file path' }, { status: 400 })
  }

  // #4: 敏感路径拦截（前缀匹配 + 扩展列表 + 大小写不敏感）
  if (isSensitivePath(normalizedPath)) {
    return NextResponse.json({ error: 'Cannot write to sensitive path' }, { status: 403 })
  }

  // #3: 归属校验 — session 必须在 DB 存在（无鉴权层下的最低归属校验）
  let session
  try {
    session = await prisma.session.findUnique({ where: { id: sessionId } })
  } catch {
    return NextResponse.json({ error: 'Failed to verify session' }, { status: 500 })
  }
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  const fullPath = resolve(baseDir, normalizedPath)

  // 文件修改检测：文件已存在时对比内容 hash
  if (!force) {
    try {
      const currentContent = await readFile(fullPath, 'utf-8')
      const currentHash = createHash('md5').update(currentContent).digest('hex')
      const newHash = createHash('md5').update(content).digest('hex')
      if (currentHash !== newHash) {
        return NextResponse.json({
          error: 'file_modified',
          message: '文件已被外部修改，是否覆盖？',
        }, { status: 409 })
      }
    } catch {
      // 文件不存在，跳过检查（新文件正常写入）
    }
  }

  try {
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, content, 'utf-8')
    return NextResponse.json({ success: true, path: fullPath })
  } catch {
    return NextResponse.json({ error: 'Failed to write file' }, { status: 500 })
  }
}

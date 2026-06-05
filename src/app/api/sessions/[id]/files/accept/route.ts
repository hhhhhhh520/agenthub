import { NextResponse } from 'next/server'
import { writeFile, mkdir, readFile } from 'fs/promises'
import { createHash } from 'crypto'
import { join, dirname, resolve } from 'path'

const SENSITIVE_PATHS = ['.env', '.git', 'node_modules', '.next']

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

  // Normalize path
  const normalizedPath = filePath.replace(/\\/g, '/')

  // Prevent path traversal
  if (normalizedPath.includes('..')) {
    return NextResponse.json({ error: 'Invalid file path' }, { status: 400 })
  }

  // Determine base directory
  const isProjectTarget = target === 'project'
  const baseDir = isProjectTarget
    ? process.cwd()
    : join(process.cwd(), 'workspaces', sessionId)

  const fullPath = resolve(baseDir, normalizedPath)

  // Ensure resolved path is within base directory
  if (!fullPath.startsWith(resolve(baseDir))) {
    return NextResponse.json({ error: 'Path traversal detected' }, { status: 400 })
  }

  // Block sensitive paths for all modes
  const parts = normalizedPath.split('/')
  for (const part of parts) {
    if (SENSITIVE_PATHS.includes(part)) {
      return NextResponse.json({ error: 'Cannot write to sensitive path' }, { status: 403 })
    }
  }

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

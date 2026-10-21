import { NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { isPathSafe } from '@/lib/path-safety'
import { prisma } from '@/lib/db'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; filename: string }> }
) {
  const { id: sessionId, filename } = await params

  // filename 遍历防护（单段，挡 .. / / \）
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return NextResponse.json({ error: 'Invalid filename' }, { status: 400 })
  }

  // #26: sessionId 必须是合法 UUID（挡 .. 注入：否则 join(cwd,'workspaces','..','.env') 读到应用 .env 泄露密钥）
  if (!UUID_RE.test(sessionId)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 })
  }

  // #26: 归属校验 — session 必须在 DB 存在
  let session
  try {
    session = await prisma.session.findUnique({ where: { id: sessionId } })
  } catch {
    return NextResponse.json({ error: 'Failed to verify session' }, { status: 500 })
  }
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  const baseDir = join(process.cwd(), 'workspaces', sessionId)
  // #8: filename 是单段，但文件本身可能是指向 workspace 外的 symlink。
  // 读取前必须 realpath 校验，不能只依赖 join + 单段检查。
  if (!isPathSafe(filename, baseDir)) {
    return NextResponse.json({ error: 'Invalid file path' }, { status: 400 })
  }

  const filePath = join(baseDir, filename)

  try {
    const content = await readFile(filePath)
    return new Response(content, {
      headers: {
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Type': 'application/octet-stream',
      },
    })
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }
}

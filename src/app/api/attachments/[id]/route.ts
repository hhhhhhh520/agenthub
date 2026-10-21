import { NextResponse } from 'next/server'
import { readFile, stat } from 'fs/promises'
import { resolve } from 'path'
import { prisma } from '@/lib/db'
import { isPathSafe } from '@/lib/path-safety'

const UPLOADS_DIR = resolve(process.cwd(), 'uploads')

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const attachment = await prisma.attachment.findUnique({ where: { id } })
  if (!attachment) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Path traversal protection（isPathSafe：realpath + sep 边界，拒绝前缀同族目录如 uploads-evil）
  const resolvedPath = resolve(attachment.path)
  if (!isPathSafe(resolvedPath, UPLOADS_DIR)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
  }

  try {
    await stat(resolvedPath)
  } catch {
    return NextResponse.json({ error: 'File not found on disk' }, { status: 404 })
  }

  const buffer = await readFile(resolvedPath)
  // SVG 可以内嵌 script；即使客户端伪造 mimeType，也不能以 inline 导航执行。
  // 其他图片仍保留 inline 预览；SVG 强制下载，并用 nosniff + CSP sandbox 兜底。
  const mimeType = attachment.mimeType.split(';', 1)[0].trim().toLowerCase()
  const isSvg = mimeType === 'image/svg+xml'
  const disposition = mimeType.startsWith('image/') && !isSvg
    ? 'inline'
    : 'attachment'
  const headers: Record<string, string> = {
    'Content-Type': attachment.mimeType,
    'Content-Disposition': `${disposition}; filename="${encodeURIComponent(attachment.filename)}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'public, max-age=31536000',
  }
  if (isSvg) headers['Content-Security-Policy'] = 'sandbox'

  return new NextResponse(buffer, { headers })
}

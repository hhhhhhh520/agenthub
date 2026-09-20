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
  const disposition = attachment.mimeType.startsWith('image/')
    ? 'inline'
    : 'attachment'

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': attachment.mimeType,
      'Content-Disposition': `${disposition}; filename="${encodeURIComponent(attachment.filename)}"`,
      'Cache-Control': 'public, max-age=31536000',
    },
  })
}

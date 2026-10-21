import { NextResponse } from 'next/server'
import { writeFile, mkdir, unlink } from 'fs/promises'
import { join, extname } from 'path'
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db'
import { readFormDataWithLimit, RequestBodyTooLargeError } from '@/lib/request-body-limit'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
export const MAX_ATTACHMENT_FILES = 10
export const MAX_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024 // 50MB
// multipart 边界/字段名开销；先按 Content-Length 拦明显超限的请求，避免 formData 全量解析。
export const MAX_ATTACHMENT_REQUEST_BYTES = MAX_ATTACHMENT_TOTAL_BYTES + 2 * 1024 * 1024
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ALLOWED_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf', 'text/plain', 'text/markdown', 'application/json',
  'text/csv', 'application/zip',
])

type UploadFile = {
  originalName: string
  filename: string
  filePath: string
  mimeType: string
  size: number
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params

  // sessionId 必须是合法 UUID（防路径遍历：join(cwd,'uploads','..','.env') 可逃逸）
  if (!UUID_RE.test(sessionId)) {
    return NextResponse.json({ error: 'Invalid session ID' }, { status: 400 })
  }

  // Verify session exists
  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  // Content-Length 是廉价早退：明显超限时不进入 formData 全量解析。
  const contentLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_ATTACHMENT_REQUEST_BYTES) {
    return NextResponse.json(
      { error: `Request body exceeds ${MAX_ATTACHMENT_REQUEST_BYTES} bytes limit` },
      { status: 413 },
    )
  }

  let formData: FormData
  try {
    // 有 body 流时按实际读取字节截断；无流的老测试/适配器回退原生解析。
    formData = request.body
      ? await readFormDataWithLimit(request, MAX_ATTACHMENT_REQUEST_BYTES)
      : await request.formData()
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: err.message }, { status: 413 })
    }
    return NextResponse.json({ error: 'Invalid FormData' }, { status: 400 })
  }

  const files = formData.getAll('files').filter((file): file is File => file instanceof File)
  if (!files.length) {
    return NextResponse.json({ error: 'No files provided' }, { status: 400 })
  }
  if (files.length > MAX_ATTACHMENT_FILES) {
    return NextResponse.json(
      { error: `Too many files (max ${MAX_ATTACHMENT_FILES})` },
      { status: 400 },
    )
  }

  // 先做全量校验，再创建目录/写文件：任何一项失败都不留下部分文件或 DB 记录。
  let totalSize = 0
  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File ${file.name} exceeds 10MB limit` },
        { status: 413 },
      )
    }
    totalSize += file.size
    if (totalSize > MAX_ATTACHMENT_TOTAL_BYTES) {
      return NextResponse.json(
        { error: `Total upload size exceeds ${MAX_ATTACHMENT_TOTAL_BYTES} bytes limit` },
        { status: 413 },
      )
    }
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: `File type ${file.type} not allowed` },
        { status: 400 },
      )
    }
  }

  const uploadDir = join(process.cwd(), 'uploads', sessionId)
  const writtenPaths: string[] = []

  try {
    await mkdir(uploadDir, { recursive: true })

    const uploads: UploadFile[] = []
    for (const file of files) {
      const ext = extname(file.name) || '.bin'
      const filename = `${randomUUID()}${ext}`
      const filePath = join(uploadDir, filename)
      const buffer = Buffer.from(await file.arrayBuffer())

      // 先记录路径再写：writeFile 部分失败时 cleanup 也能覆盖半成品。
      writtenPaths.push(filePath)
      await writeFile(filePath, buffer)

      uploads.push({
        originalName: file.name,
        filename,
        filePath,
        mimeType: file.type,
        size: file.size,
      })
    }

    // 所有 DB 记录一次事务落库；任一失败则回滚，不留下“文件已写但记录缺失”。
    const attachments = await prisma.$transaction(
      uploads.map(upload => prisma.attachment.create({
        data: {
          filename: upload.originalName,
          path: upload.filePath,
          mimeType: upload.mimeType,
          size: upload.size,
          sessionId,
        },
      })),
    )

    return NextResponse.json(attachments.map(attachment => ({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
    })))
  } catch (err) {
    // 文件写入或 DB 事务失败：清掉本次已写文件，避免孤儿盘文件。
    for (const filePath of writtenPaths) {
      try { await unlink(filePath) } catch { /* best-effort */ }
    }
    console.error('[attachments] upload failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Failed to save attachments' }, { status: 500 })
  }
}

import { NextResponse } from 'next/server'
import { writeFile, mkdir } from 'fs/promises'
import { join, extname } from 'path'
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
const ALLOWED_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf', 'text/plain', 'text/markdown', 'application/json',
  'text/csv', 'application/zip',
])

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params

  // Verify session exists
  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid FormData' }, { status: 400 })
  }

  const files = formData.getAll('files')
  if (!files.length) {
    return NextResponse.json({ error: 'No files provided' }, { status: 400 })
  }

  const uploadDir = join(process.cwd(), 'uploads', sessionId)
  await mkdir(uploadDir, { recursive: true })

  const results: Array<{ id: string; filename: string; mimeType: string; size: number }> = []

  for (const file of files) {
    if (!(file instanceof File)) continue

    // Size check
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File ${file.name} exceeds 10MB limit` },
        { status: 413 }
      )
    }

    // Type check
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: `File type ${file.type} not allowed` },
        { status: 400 }
      )
    }

    const ext = extname(file.name) || '.bin'
    const filename = `${randomUUID()}${ext}`
    const filePath = join(uploadDir, filename)

    const buffer = Buffer.from(await file.arrayBuffer())
    await writeFile(filePath, buffer)

    const attachment = await prisma.attachment.create({
      data: {
        filename: file.name,
        path: filePath,
        mimeType: file.type,
        size: file.size,
        sessionId,
      },
    })

    results.push({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
    })
  }

  return NextResponse.json(results)
}

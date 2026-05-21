import { NextResponse } from 'next/server'
import { writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params
  const { filePath, content } = await request.json()

  if (!filePath || content === undefined) {
    return NextResponse.json({ error: 'filePath and content are required' }, { status: 400 })
  }

  // Path traversal protection
  if (filePath.includes('..') || filePath.includes('/') || filePath.includes('\\')) {
    return NextResponse.json({ error: 'Invalid file path' }, { status: 400 })
  }

  const fullPath = join(process.cwd(), 'workspaces', sessionId, filePath)

  try {
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, content, 'utf-8')
    return NextResponse.json({ success: true, path: fullPath })
  } catch {
    return NextResponse.json({ error: 'Failed to write file' }, { status: 500 })
  }
}

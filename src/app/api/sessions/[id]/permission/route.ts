import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { processRegistry } from '@/lib/adapter/process-registry'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params
  const body = await request.json()
  const { requestId, behavior, updatedInput, message, agentId } = body

  if (!requestId || !behavior || !agentId) {
    return Response.json({ error: 'Missing required fields: requestId, behavior, agentId' }, { status: 400 })
  }

  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 })
  }

  const success = processRegistry.respondPermissionByRequestId(requestId, {
    behavior,
    updatedInput,
    message,
  })
  if (!success) {
    return Response.json({ error: 'Permission request not found or already expired' }, { status: 404 })
  }

  return Response.json({ ok: true })
}

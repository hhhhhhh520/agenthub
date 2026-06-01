import { unlink } from 'fs/promises'
import { prisma } from '@/lib/db'

export async function cleanupAttachmentFiles(attachments: { path: string }[]): Promise<void> {
  for (const att of attachments) {
    try {
      await unlink(att.path)
    } catch {
      // File may already be deleted, ignore
    }
  }
}

export async function cleanupOrphanAttachments(sessionId: string): Promise<void> {
  // Delete attachments with no messageId older than 1 hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
  const orphans = await prisma.attachment.findMany({
    where: {
      sessionId,
      messageId: null,
      createdAt: { lt: oneHourAgo },
    },
  })
  if (orphans.length > 0) {
    await cleanupAttachmentFiles(orphans)
    await prisma.attachment.deleteMany({
      where: { id: { in: orphans.map(a => a.id) } },
    })
  }
}

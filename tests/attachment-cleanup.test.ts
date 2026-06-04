import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mock fs/promises ---
const { mockUnlink } = vi.hoisted(() => ({
  mockUnlink: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('fs/promises', () => ({
  unlink: mockUnlink,
}))

// --- Mock prisma ---
const { mockFindMany, mockDeleteMany } = vi.hoisted(() => ({
  mockFindMany: vi.fn().mockResolvedValue([]),
  mockDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    attachment: {
      findMany: mockFindMany,
      deleteMany: mockDeleteMany,
    },
  },
}))

import { cleanupAttachmentFiles, cleanupOrphanAttachments } from '@/lib/attachment-cleanup'

beforeEach(() => {
  vi.clearAllMocks()
  mockUnlink.mockResolvedValue(undefined)
  mockFindMany.mockResolvedValue([])
  mockDeleteMany.mockResolvedValue({ count: 0 })
})

describe('cleanupAttachmentFiles', () => {
  it('deletes all attachment files', async () => {
    await cleanupAttachmentFiles([
      { path: '/uploads/a.png' },
      { path: '/uploads/b.pdf' },
    ])
    expect(mockUnlink).toHaveBeenCalledTimes(2)
    expect(mockUnlink).toHaveBeenCalledWith('/uploads/a.png')
    expect(mockUnlink).toHaveBeenCalledWith('/uploads/b.pdf')
  })

  it('ignores errors when file already deleted', async () => {
    mockUnlink.mockRejectedValueOnce(new Error('ENOENT'))
    await cleanupAttachmentFiles([{ path: '/gone.png' }])
    // Should not throw
    expect(mockUnlink).toHaveBeenCalledTimes(1)
  })

  it('handles empty array', async () => {
    await cleanupAttachmentFiles([])
    expect(mockUnlink).not.toHaveBeenCalled()
  })
})

describe('cleanupOrphanAttachments', () => {
  it('finds and deletes orphan attachments older than 1 hour', async () => {
    const orphans = [
      { id: 'att-1', path: '/uploads/orphan1.png' },
      { id: 'att-2', path: '/uploads/orphan2.pdf' },
    ]
    mockFindMany.mockResolvedValue(orphans)

    await cleanupOrphanAttachments('sess-1')

    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        sessionId: 'sess-1',
        messageId: null,
        createdAt: { lt: expect.any(Date) },
      },
    })
    expect(mockUnlink).toHaveBeenCalledTimes(2)
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['att-1', 'att-2'] } },
    })
  })

  it('does nothing when no orphans found', async () => {
    mockFindMany.mockResolvedValue([])

    await cleanupOrphanAttachments('sess-1')

    expect(mockUnlink).not.toHaveBeenCalled()
    expect(mockDeleteMany).not.toHaveBeenCalled()
  })

  it('handles file deletion errors gracefully', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'att-1', path: '/gone.png' },
    ])
    mockUnlink.mockRejectedValue(new Error('ENOENT'))

    // Should not throw
    await cleanupOrphanAttachments('sess-1')
    expect(mockDeleteMany).toHaveBeenCalled()
  })
})

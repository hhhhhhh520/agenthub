import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  sessionFindUnique: vi.fn(),
  sessionDelete: vi.fn(),
  attachmentFindMany: vi.fn(),
  cleanupAttachmentFiles: vi.fn(),
  cleanupShadowGit: vi.fn(),
  cancelByOwnerSession: vi.fn(),
  waitForSessionUnlock: vi.fn(),
  requestSessionCancel: vi.fn(),
  clearSessionCancel: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    session: { findUnique: mocks.sessionFindUnique, delete: mocks.sessionDelete },
    attachment: { findMany: mocks.attachmentFindMany },
  },
}))

vi.mock('@/lib/adapter/process-registry', () => ({
  processRegistry: { cancelByOwnerSession: mocks.cancelByOwnerSession },
}))

vi.mock('@/lib/session-lock', () => ({
  waitForSessionUnlock: mocks.waitForSessionUnlock,
}))

vi.mock('@/lib/cancellation', () => ({
  requestSessionCancel: mocks.requestSessionCancel,
  clearSessionCancel: mocks.clearSessionCancel,
}))

vi.mock('@/lib/attachment-cleanup', () => ({
  cleanupAttachmentFiles: mocks.cleanupAttachmentFiles,
}))

vi.mock('@/lib/services/shadow-git', () => ({
  cleanupShadowGit: mocks.cleanupShadowGit,
}))

import { DELETE } from '@/app/api/sessions/[id]/route'
import { POST as stopPOST } from '@/app/api/sessions/[id]/stop/route'

const params = { params: Promise.resolve({ id: 's1' }) }

function req() {
  return new Request('http://localhost/api/sessions/s1', { method: 'DELETE' })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.sessionFindUnique.mockResolvedValue({ projectDir: '/tmp/project' })
  mocks.sessionDelete.mockResolvedValue({})
  mocks.attachmentFindMany.mockResolvedValue([])
  mocks.cleanupAttachmentFiles.mockResolvedValue(undefined)
  mocks.cancelByOwnerSession.mockResolvedValue({ total: 1, exited: 1, unconfirmed: [] })
  mocks.waitForSessionUnlock.mockResolvedValue(true)
})

describe('DELETE /api/sessions/[id] — 取消 → 退出 → 锁释放 → 删除', () => {
  it('全部确认后才删除，并按顺序执行', async () => {
    const res = await DELETE(req(), params)
    expect(res.status).toBe(200)

    expect(mocks.requestSessionCancel).toHaveBeenCalledWith('s1')
    expect(mocks.cancelByOwnerSession).toHaveBeenCalledWith('s1', { graceMs: 5000, forceMs: 5000 })
    expect(mocks.waitForSessionUnlock).toHaveBeenCalledWith('s1', 30000)
    expect(mocks.sessionDelete).toHaveBeenCalledWith({ where: { id: 's1' } })
    expect(mocks.clearSessionCancel).toHaveBeenCalledWith('s1')

    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0]
    expect(order(mocks.requestSessionCancel)).toBeLessThan(order(mocks.cancelByOwnerSession))
    expect(order(mocks.cancelByOwnerSession)).toBeLessThan(order(mocks.waitForSessionUnlock))
    expect(order(mocks.waitForSessionUnlock)).toBeLessThan(order(mocks.sessionDelete))
    expect(order(mocks.sessionDelete)).toBeLessThan(order(mocks.clearSessionCancel))
  })

  it('进程未确认退出 → 409，不删 DB、不清取消标记', async () => {
    mocks.cancelByOwnerSession.mockResolvedValue({ total: 1, exited: 0, unconfirmed: ['key-1'] })

    const res = await DELETE(req(), params)

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ unconfirmed: ['key-1'] })
    expect(mocks.sessionDelete).not.toHaveBeenCalled()
    expect(mocks.clearSessionCancel).not.toHaveBeenCalled()
  })

  it('业务锁未释放 → 409，不删 DB', async () => {
    mocks.waitForSessionUnlock.mockResolvedValue(false)

    const res = await DELETE(req(), params)

    expect(res.status).toBe(409)
    expect(mocks.sessionDelete).not.toHaveBeenCalled()
    expect(mocks.clearSessionCancel).not.toHaveBeenCalled()
  })
})

describe('POST /api/sessions/[id]/stop — 只停止不删除', () => {
  it('确认停止 → 200，清取消标记，不删会话', async () => {
    const res = await stopPOST(new Request('http://localhost', { method: 'POST' }), params)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ stopped: true, total: 1, exited: 1 })

    expect(mocks.requestSessionCancel).toHaveBeenCalledWith('s1')
    expect(mocks.cancelByOwnerSession).toHaveBeenCalledWith('s1', { graceMs: 5000, forceMs: 5000 })
    expect(mocks.clearSessionCancel).toHaveBeenCalledWith('s1')
    expect(mocks.sessionDelete).not.toHaveBeenCalled()
  })

  it('未确认退出 → 202，保留取消标记，防止被杀期间重建', async () => {
    mocks.cancelByOwnerSession.mockResolvedValue({ total: 1, exited: 0, unconfirmed: ['key-1'] })

    const res = await stopPOST(new Request('http://localhost', { method: 'POST' }), params)
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ stopped: false, unconfirmed: ['key-1'] })
    expect(mocks.clearSessionCancel).not.toHaveBeenCalled()
  })

  it('会话不存在 → 404', async () => {
    mocks.sessionFindUnique.mockResolvedValue(null)
    const res = await stopPOST(new Request('http://localhost', { method: 'POST' }), params)
    expect(res.status).toBe(404)
  })
})

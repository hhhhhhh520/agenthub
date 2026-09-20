import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolve } from 'path'

const { mockFindUnique } = vi.hoisted(() => ({ mockFindUnique: vi.fn() }))

vi.mock('@/lib/db', () => ({
  prisma: { attachment: { findUnique: mockFindUnique } },
}))

import { GET } from '@/app/api/attachments/[id]/route'

const params = (id = 'att-1') => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/attachments/[id] — 路径校验（前缀同族必须拒绝）', () => {
  it('拒绝 uploads 前缀同族目录（uploads-evil 不再被裸 startsWith 放行）', async () => {
    // 旧实现 `resolvedPath.startsWith(UPLOADS_DIR)` 会放行 <cwd>/uploads-evil/secret.txt
    mockFindUnique.mockResolvedValue({
      id: 'att-1',
      path: resolve(process.cwd(), 'uploads-evil', 'secret.txt'),
      mimeType: 'text/plain',
    })
    const res = await GET(new Request('http://localhost/api/attachments/att-1'), params())
    expect(res.status).toBe(400)
  })

  it('拒绝完全在 uploads 之外的路径', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'att-1',
      path: resolve(process.cwd(), '..', 'outside.txt'),
      mimeType: 'text/plain',
    })
    const res = await GET(new Request('http://localhost/api/attachments/att-1'), params())
    expect(res.status).toBe(400)
  })

  it('不存在的附件返回 404（不受路径校验影响）', async () => {
    mockFindUnique.mockResolvedValue(null)
    const res = await GET(new Request('http://localhost/api/attachments/att-1'), params())
    expect(res.status).toBe(404)
  })
})

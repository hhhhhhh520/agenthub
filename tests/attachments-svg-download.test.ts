import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolve } from 'path'

const { mockFindUnique, mockStat, mockReadFile } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockStat: vi.fn(),
  mockReadFile: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: { attachment: { findUnique: mockFindUnique } },
}))

vi.mock('fs/promises', () => ({
  stat: mockStat,
  readFile: mockReadFile,
}))

import { GET } from '@/app/api/attachments/[id]/route'

const params = (id = 'att-svg') => ({ params: Promise.resolve({ id }) })

const baseAttachment = {
  id: 'att-svg',
  path: resolve(process.cwd(), 'uploads', 'att-svg.svg'),
  filename: 'diagram.svg',
  mimeType: 'image/svg+xml',
  size: 128,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFindUnique.mockResolvedValue(baseAttachment)
  mockStat.mockResolvedValue({ size: 128 })
  mockReadFile.mockResolvedValue(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))
})

describe('GET /api/attachments/[id] — SVG 安全响应头', () => {
  it('SVG 必须作为 attachment 返回，并带 nosniff/sandbox', async () => {
    const res = await GET(new Request('http://localhost/api/attachments/att-svg'), params())

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment;/)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Content-Security-Policy')).toContain('sandbox')
  })

  it('普通 PNG 仍可 inline，并带 nosniff', async () => {
    mockFindUnique.mockResolvedValue({
      ...baseAttachment,
      id: 'att-png',
      path: resolve(process.cwd(), 'uploads', 'att-png.png'),
      filename: 'photo.png',
      mimeType: 'image/png',
    })

    const res = await GET(new Request('http://localhost/api/attachments/att-png'), params('att-png'))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toMatch(/^inline;/)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Content-Security-Policy')).toBeNull()
  })
})

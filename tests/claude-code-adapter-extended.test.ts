import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mock setup ---
const { mockGetOrCreate, mockSend } = vi.hoisted(() => ({
  mockGetOrCreate: vi.fn().mockReturnValue({ sessionId: null }),
  mockSend: vi.fn(),
}))

vi.mock('@/lib/adapter/process-registry', () => ({
  processRegistry: {
    getOrCreate: mockGetOrCreate,
    send: mockSend,
  },
}))

const { mockReadFileSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
}))

vi.mock('fs', () => ({
  readFileSync: mockReadFileSync,
}))

import { ClaudeCodeAdapter } from '@/lib/adapter/claude-code-adapter'

beforeEach(() => {
  vi.clearAllMocks()
  mockGetOrCreate.mockReturnValue({ sessionId: null })
  mockSend.mockImplementation(async function* () {})
})

describe('ClaudeCodeAdapter — extended coverage', () => {
  describe('send — non-image attachments', () => {
    it('adds file references to prompt for non-image attachments', async () => {
      const adapter = new ClaudeCodeAdapter()
      await adapter.connect({ platform: 'claude-code', workDir: '/dir' })

      const gen = adapter.send({
        prompt: 'analyze this',
        attachments: [
          { id: 'a1', filename: 'report.pdf', path: '/uploads/report.pdf', mimeType: 'application/pdf', size: 1000 },
        ],
      })
      await gen.next()

      const prompt = mockSend.mock.calls[0][1]
      expect(prompt).toContain('用户附带了以下文件')
      expect(prompt).toContain('report.pdf')
      expect(prompt).toContain('/uploads/report.pdf')
      // Image attachments should NOT be in the file list
      expect(mockSend.mock.calls[0][3]).toEqual([])
    })

    it('separates image and non-image attachments', async () => {
      mockReadFileSync.mockReturnValue(Buffer.from('fake-image-data'))
      const adapter = new ClaudeCodeAdapter()
      await adapter.connect({ platform: 'claude-code', workDir: '/dir' })

      const gen = adapter.send({
        prompt: 'describe',
        attachments: [
          { id: 'a1', filename: 'photo.png', path: '/uploads/photo.png', mimeType: 'image/png', size: 500 },
          { id: 'a2', filename: 'data.csv', path: '/uploads/data.csv', mimeType: 'text/csv', size: 200 },
        ],
      })
      await gen.next()

      const prompt = mockSend.mock.calls[0][1]
      // Non-image in prompt
      expect(prompt).toContain('data.csv')
      // Image in imageAttachments array
      const imageAttachments = mockSend.mock.calls[0][3]
      expect(imageAttachments.length).toBe(1)
      expect(imageAttachments[0].mimeType).toBe('image/png')
    })
  })

  describe('send — image attachments with readFileSync', () => {
    it('reads image files and passes base64 to processRegistry', async () => {
      mockReadFileSync.mockReturnValue(Buffer.from('image-bytes'))
      const adapter = new ClaudeCodeAdapter()
      await adapter.connect({ platform: 'claude-code', workDir: '/dir' })

      const gen = adapter.send({
        prompt: 'what is this',
        attachments: [
          { id: 'a1', filename: 'screenshot.png', path: '/tmp/shot.png', mimeType: 'image/png', size: 100 },
        ],
      })
      await gen.next()

      expect(mockReadFileSync).toHaveBeenCalledWith('/tmp/shot.png')
      const imageAttachments = mockSend.mock.calls[0][3]
      expect(imageAttachments).toEqual([
        { mimeType: 'image/png', data: Buffer.from('image-bytes').toString('base64') },
      ])
    })

    it('skips images that fail to read', async () => {
      mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT') })
      const adapter = new ClaudeCodeAdapter()
      await adapter.connect({ platform: 'claude-code', workDir: '/dir' })

      const gen = adapter.send({
        prompt: 'describe',
        attachments: [
          { id: 'a1', filename: 'missing.png', path: '/no/such/file.png', mimeType: 'image/png', size: 100 },
        ],
      })
      await gen.next()

      const imageAttachments = mockSend.mock.calls[0][3]
      expect(imageAttachments).toEqual([])
    })
  })

  describe('send — sessionId update from entry', () => {
    it('updates sessionId when entry has one', async () => {
      mockGetOrCreate.mockReturnValue({ sessionId: 'existing-sess' })
      const adapter = new ClaudeCodeAdapter()
      await adapter.connect({ platform: 'claude-code', workDir: '/dir' })

      const gen = adapter.send({ prompt: 'test' })
      await gen.next()

      expect((adapter as any).sessionId).toBe('existing-sess')
    })

    it('preserves config sessionId when entry has none', async () => {
      mockGetOrCreate.mockReturnValue({ sessionId: null })
      const adapter = new ClaudeCodeAdapter()
      await adapter.connect({ platform: 'claude-code', workDir: '/dir', sessionId: 'config-sess' })

      const gen = adapter.send({ prompt: 'test' })
      await gen.next()

      expect((adapter as any).sessionId).toBe('config-sess')
    })
  })

  describe('send — systemPrompt + attachments combined (no context — CLI manages history)', () => {
    it('builds full prompt with systemPrompt and attachments', async () => {
      mockReadFileSync.mockReturnValue(Buffer.from('img'))
      const adapter = new ClaudeCodeAdapter()
      await adapter.connect({ platform: 'claude-code', workDir: '/dir' })

      const gen = adapter.send({
        prompt: 'main task',
        systemPrompt: 'you are a reviewer',
        context: 'project context',
        attachments: [
          { id: 'a1', filename: 'code.ts', path: '/src/code.ts', mimeType: 'text/typescript', size: 500 },
          { id: 'a2', filename: 'diagram.png', path: '/img/diagram.png', mimeType: 'image/png', size: 300 },
        ],
      })
      await gen.next()

      const prompt = mockSend.mock.calls[0][1]
      expect(prompt).toContain('you are a reviewer')
      // context 不再拼接到 prompt（CLI 通过 session 恢复管理历史）
      expect(prompt).not.toContain('背景信息：')
      expect(prompt).not.toContain('project context')
      expect(prompt).toContain('code.ts')
      expect(prompt).toContain('main task')

      // Image should be in imageAttachments, not in prompt text
      const imageAttachments = mockSend.mock.calls[0][3]
      expect(imageAttachments.length).toBe(1)
      expect(imageAttachments[0].mimeType).toBe('image/png')
    })
  })
})

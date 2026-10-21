import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from '@/app/api/config/test-connection/route'

const mocks = vi.hoisted(() => ({
  detect: vi.fn(),
  testLLM: vi.fn(),
}))

vi.mock('@/lib/cli-detect', () => ({ detectCLIPlatform: mocks.detect }))
vi.mock('@/lib/llm-connection', () => ({ testLLMConnection: mocks.testLLM }))

describe('POST /api/config/test-connection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('手动配置草稿会实际测试草稿，而不是只检测 CLI', async () => {
    mocks.testLLM.mockResolvedValue('OK')
    const res = await POST(new Request('http://localhost/api/config/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'draft-key', model: 'gpt-test', baseUrl: 'https://example.com/v1' }),
    }))

    expect(mocks.testLLM).toHaveBeenCalledWith({
      apiKey: 'draft-key',
      model: 'gpt-test',
      baseUrl: 'https://example.com/v1',
    })
    expect(mocks.detect).not.toHaveBeenCalled()
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ success: true, response: 'OK', platform: 'api' })
  })

  it('没有草稿时保持 CLI 检测语义', async () => {
    mocks.detect.mockReturnValue('claude-code')
    const res = await POST(new Request('http://localhost/api/config/test-connection', { method: 'POST' }))

    expect(mocks.detect).toHaveBeenCalledTimes(1)
    expect(mocks.testLLM).not.toHaveBeenCalled()
    await expect(res.json()).resolves.toMatchObject({ success: true, platform: 'claude-code' })
  })

  it('草稿测试失败返回可展示错误且不保存配置', async () => {
    mocks.testLLM.mockRejectedValue(new Error('upstream 401: sk-secret-value'))
    const res = await POST(new Request('http://localhost/api/config/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'draft-key', model: 'gpt-test' }),
    }))

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toContain('401')
    expect(json.error).not.toContain('sk-secret-value')
  })

  it('有草稿但缺少 API Key 时明确拒绝', async () => {
    const res = await POST(new Request('http://localhost/api/config/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test' }),
    }))

    expect(res.status).toBe(400)
    expect(mocks.testLLM).not.toHaveBeenCalled()
  })
})

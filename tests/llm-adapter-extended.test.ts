import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mock setup ---
const { mockCreateAnthropic, mockCreateOpenAI, mockStreamText } = vi.hoisted(() => {
  const makeProvider = () => vi.fn().mockReturnValue('mock-model')
  return {
    mockCreateAnthropic: vi.fn().mockReturnValue(makeProvider()),
    mockCreateOpenAI: vi.fn().mockReturnValue(makeProvider()),
    mockStreamText: vi.fn().mockReturnValue({
      textStream: (async function* () { yield 'hello' })(),
    }),
  }
})

vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: mockCreateAnthropic }))
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: mockCreateOpenAI }))
vi.mock('ai', () => ({ streamText: mockStreamText }))

import { LLMAdapter } from '@/lib/adapter/llm-adapter'

beforeEach(() => {
  vi.clearAllMocks()
  // Reset provider mocks to return fresh fns
  mockCreateAnthropic.mockReturnValue(vi.fn().mockReturnValue('anthropic-model'))
  mockCreateOpenAI.mockReturnValue(vi.fn().mockReturnValue('openai-model'))
})

describe('LLMAdapter — uncovered paths', () => {
  it('claude model without baseUrl → Anthropic branch', async () => {
    const adapter = new LLMAdapter()
    await adapter.connect({ platform: 'claude-code', model: 'claude-sonnet-4-20250514' })
    const chunks: any[] = []
    for await (const chunk of adapter.send({ prompt: 'hi' })) {
      chunks.push(chunk)
    }
    expect(mockCreateAnthropic).toHaveBeenCalled()
    expect(mockCreateOpenAI).not.toHaveBeenCalled()
  })

  it('gpt model without baseUrl → OpenAI branch', async () => {
    const adapter = new LLMAdapter()
    await adapter.connect({ platform: 'claude-code', model: 'gpt-4' })
    const chunks: any[] = []
    for await (const chunk of adapter.send({ prompt: 'hi' })) {
      chunks.push(chunk)
    }
    expect(mockCreateOpenAI).toHaveBeenCalled()
    expect(mockCreateAnthropic).not.toHaveBeenCalled()
  })

  it('baseUrl without /v1 → appends /v1', async () => {
    const adapter = new LLMAdapter()
    await adapter.connect({ platform: 'claude-code', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test' })
    const chunks: any[] = []
    for await (const chunk of adapter.send({ prompt: 'hi' })) {
      chunks.push(chunk)
    }
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://api.deepseek.com/v1' })
    )
  })

  it('baseUrl with /v1 → does not append', async () => {
    const adapter = new LLMAdapter()
    await adapter.connect({ platform: 'claude-code', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test' })
    const chunks: any[] = []
    for await (const chunk of adapter.send({ prompt: 'hi' })) {
      chunks.push(chunk)
    }
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://api.deepseek.com/v1' })
    )
  })

  it('close aborts the controller', async () => {
    const adapter = new LLMAdapter()
    await adapter.connect({ platform: 'claude-code', apiKey: 'sk-test' })
    // spy on abortController.abort
    const abortSpy = vi.spyOn((adapter as any).abortController, 'abort')
    await adapter.close()
    // 验证 abort 被调用
    expect(abortSpy).toHaveBeenCalledOnce()
    // 验证 abortSignal 已触发
    expect((adapter as any).abortController.signal.aborted).toBe(true)
  })
})

import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'
import { detectUseAnthropic } from '@/lib/adapter/llm-adapter'
import { assertSafeBaseUrl } from '@/lib/orchestrator/decision-llm'

export interface DraftLLMConfig {
  apiKey: string
  model: string
  baseUrl: string
}

/** 用表单草稿做一次最小生成请求；失败直接抛给 route 转成可展示错误。 */
export async function testLLMConnection(config: DraftLLMConfig): Promise<string> {
  const apiKey = config.apiKey.trim()
  const model = config.model.trim() || 'claude-sonnet-4-20250514'
  const baseUrl = config.baseUrl.trim()
  if (!apiKey) throw new Error('API Key 不能为空')
  if (baseUrl) assertSafeBaseUrl(baseUrl)

  const llm = detectUseAnthropic(baseUrl, model)
    ? createAnthropic({
        apiKey,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
      })(model)
    : createOpenAI({
        apiKey,
        ...(baseUrl ? { baseURL: normalizeOpenAIBaseUrl(baseUrl) } : {}),
      }).chat(model)

  const result = await generateText({
    model: llm,
    prompt: '只回复 OK',
    maxOutputTokens: 16,
    abortSignal: AbortSignal.timeout(15_000),
  })
  const text = result.text.trim()
  if (!text) throw new Error('模型返回空内容')
  return text.slice(0, 120)
}

function normalizeOpenAIBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return /\/v1\/?$/.test(trimmed) ? trimmed : `${trimmed}/v1`
}

import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { streamText } from 'ai'
import type { AgentAdapter, AdapterConfig, AgentTask, StreamChunk } from './types'

export class LLMAdapter implements AgentAdapter {
  private config: AdapterConfig = { platform: 'llm' }
  private abortController = new AbortController()

  async connect(config: AdapterConfig): Promise<void> {
    this.config = config
  }

  async *send(task: AgentTask): AsyncIterable<StreamChunk> {
    const model = this.config.model || 'claude-sonnet-4-20250514'
    const baseUrl = this.config.baseUrl
    const apiKey = this.config.apiKey

    // 判断使用哪个 SDK：
    // 1. 有 baseUrl → 大多数兼容 API 是 OpenAI 格式（DeepSeek、Moonshot、讯飞等）
    // 2. 没有 baseUrl + 模型名以 gpt-/o1-/o3- 开头 → OpenAI
    // 3. 其他情况 → Anthropic（Claude 系列）
    const useOpenAI = baseUrl
      ? true  // 自定义 baseUrl 通常是 OpenAI 兼容格式
      : /^(gpt-|o1-|o3-)/.test(model)

    let llm
    if (useOpenAI) {
      // createOpenAI 的 baseURL 默认是 https://api.openai.com/v1
      // 路径拼接: baseURL + /chat/completions → 必须包含 /v1
      // 用户常填 https://api.deepseek.com → 需要补 /v1
      let normalizedBaseUrl = baseUrl?.replace(/\/+$/, '') || undefined
      if (normalizedBaseUrl && !/\/v1\/?$/.test(normalizedBaseUrl)) {
        normalizedBaseUrl = `${normalizedBaseUrl}/v1`
      }
      const provider = createOpenAI({
        ...(normalizedBaseUrl && { baseURL: normalizedBaseUrl }),
        ...(apiKey && { apiKey }),
      })
      llm = provider(model)
    } else {
      const provider = createAnthropic({
        ...(apiKey && { apiKey }),
      })
      llm = provider(model)
    }

    const prompt = task.context
      ? `Context:\n${task.context}\n\n---\n\n${task.prompt}`
      : task.prompt

    try {
      const result = streamText({
        model: llm,
        system: task.systemPrompt,
        prompt,
        abortSignal: this.abortController.signal,
      })

      for await (const chunk of result.textStream) {
        yield { type: 'text', content: chunk }
      }
    } catch (error) {
      yield { type: 'error', content: String(error) }
    }
  }

  async close(): Promise<void> {
    this.abortController.abort()
  }
}

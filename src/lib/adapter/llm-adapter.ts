import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { streamText } from 'ai'
import type { AgentAdapter, AdapterConfig, AgentTask, StreamChunk } from './types'

export class LLMAdapter implements AgentAdapter {
  private config: AdapterConfig = { platform: 'llm' }

  async connect(config: AdapterConfig): Promise<void> {
    this.config = config
  }

  async *send(task: AgentTask): AsyncIterable<StreamChunk> {
    const model = this.config.model || 'claude-sonnet-4-20250514'
    const baseUrl = this.config.baseUrl
    const apiKey = this.config.apiKey

    const isOpenAI = /^(gpt-|o1-|o3-)/.test(model)

    let llm
    if (isOpenAI) {
      const provider = createOpenAI({
        ...(baseUrl && { baseURL: baseUrl }),
        ...(apiKey && { apiKey }),
      })
      llm = provider(model)
    } else {
      const provider = createAnthropic({
        ...(baseUrl && { baseURL: baseUrl }),
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
      })

      for await (const chunk of result.textStream) {
        yield { type: 'text', content: chunk }
      }
    } catch (error) {
      yield { type: 'error', content: String(error) }
    }
  }

  async close(): Promise<void> {
    // HTTP-based API, no persistent connection to close
  }
}

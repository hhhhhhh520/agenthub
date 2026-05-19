import type { AgentAdapter, AdapterConfig } from './types'
import { LLMAdapter } from './llm-adapter'

export function createAdapter(config: AdapterConfig): AgentAdapter {
  switch (config.platform) {
    case 'llm':
      return new LLMAdapter()
    case 'claude-code':
      // Placeholder - implemented in Task 10
      return new LLMAdapter()
    case 'codex':
      // Placeholder - future extension
      return new LLMAdapter()
    default:
      return new LLMAdapter()
  }
}

export type { AgentAdapter, AdapterConfig, AgentTask, StreamChunk } from './types'

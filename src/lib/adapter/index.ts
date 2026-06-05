import type { AgentAdapter, AdapterConfig } from './types'
import { ClaudeCodeAdapter } from './claude-code-adapter'
import { OpenCodeAdapter } from './opencode-adapter'

export function createAdapter(config: AdapterConfig): AgentAdapter {
  switch (config.platform) {
    case 'claude-code':
      return new ClaudeCodeAdapter()
    case 'opencode':
      return new OpenCodeAdapter()
    default:
      return new ClaudeCodeAdapter()
  }
}

export type { AgentAdapter, AdapterConfig, AgentTask, StreamChunk } from './types'

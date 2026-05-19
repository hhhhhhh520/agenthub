export interface AdapterConfig {
  platform: 'llm' | 'claude-code' | 'codex'
  apiKey?: string
  workDir?: string
  model?: string
}

export interface AgentTask {
  prompt: string
  context?: string
  systemPrompt?: string
}

export interface StreamChunk {
  type: 'text' | 'code' | 'file' | 'status' | 'error'
  content: string
}

export interface AgentAdapter {
  connect(config: AdapterConfig): Promise<void>
  send(task: AgentTask): AsyncIterable<StreamChunk>
  close(): Promise<void>
}

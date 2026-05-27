export interface AdapterConfig {
  platform: 'llm' | 'claude-code' | 'opencode'
  apiKey?: string
  workDir?: string
  model?: string
  baseUrl?: string
  sessionId?: string
  permissionMode?: 'default' | 'auto'
}

export interface AgentTask {
  prompt: string
  context?: string
  systemPrompt?: string
}

export interface StreamChunk {
  type: 'text' | 'code' | 'file' | 'status' | 'error' | 'session'
  content: string
}

export interface AgentAdapter {
  connect(config: AdapterConfig): Promise<void>
  send(task: AgentTask): AsyncIterable<StreamChunk>
  close(): Promise<void>
}

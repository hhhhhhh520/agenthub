export interface AdapterConfig {
  platform: 'claude-code' | 'opencode'
  apiKey?: string
  workDir?: string
  model?: string
  baseUrl?: string
  sessionId?: string
  permissionMode?: 'default' | 'auto'
  mcpConfig?: string  // --mcp-config JSON string for MCP tool support
  agentId?: string      // For ProcessRegistry key
  chatSessionId?: string // For ProcessRegistry key
  allowedTools?: string[]   // CLI tool whitelist (e.g. ["Read", "Write", "Edit"])
  disallowedTools?: string[] // CLI tool blacklist
}

export interface TaskAttachment {
  id: string
  filename: string
  path: string
  mimeType: string
  size: number
}

export interface AgentTask {
  prompt: string
  context?: string
  systemPrompt?: string
  attachments?: TaskAttachment[]
}

export interface StreamChunk {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'code' | 'file' | 'status' | 'error' | 'session' | 'permission_request' | 'permission_cancel'
  content: string
  data?: {
    requestId?: string
    toolName?: string
    toolInput?: Record<string, unknown>
    toolResult?: string
    retry?: number
    quality?: string
  }
}

export interface AgentAdapter {
  connect(config: AdapterConfig): Promise<void>
  send(task: AgentTask): AsyncIterable<StreamChunk>
  close(): Promise<void>
}

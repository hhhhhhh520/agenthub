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

import type { SpawnConfig } from './process-registry'

export interface AgentAdapter {
  connect(config: AdapterConfig): Promise<void>
  send(task: AgentTask): AsyncIterable<StreamChunk>
  close(): Promise<void>
  /**
   * 返回此 adapter 在 ProcessRegistry 中的注册 key。
   * 必须在 connect() 之后调用。
   *
   * ❌-1 防御:orchestrator 杀进程时不要自己拼 key,
   * 必须用 adapter.getRegistryKey() 拿权威值。
   */
  getRegistryKey(): string
  /**
   * 返回 send() 时真正用于 spawn 的 SpawnConfig 对象引用。
   * 必须在 send() 至少一次成功 spawn 后调用,否则返回 null。
   * adapter.close() 时清空。
   *
   * ❌-1 防御:orchestrator 调 gracefulKillEntry 时必须用此 config,
   * 否则 buildConfigHash 算出的 effectiveKey 与 spawn 时不一致,
   * 导致 registry.get 返回 undefined,杀进程静默失败。
   */
  getSpawnConfig(): SpawnConfig | null
}

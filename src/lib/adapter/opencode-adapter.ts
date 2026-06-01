import { join } from 'path'
import type { AgentAdapter, AdapterConfig, AgentTask, StreamChunk } from './types'
import { processRegistry } from './process-registry'

export class OpenCodeAdapter implements AgentAdapter {
  private config: AdapterConfig = { platform: 'opencode' }
  private workDir: string = ''
  private sessionId: string | null = null
  private agentId: string | undefined
  private chatSessionId: string | undefined

  async connect(config: AdapterConfig): Promise<void> {
    this.config = config
    this.workDir = config.workDir || join(process.cwd(), 'workspaces', `opencode-${Date.now()}`)
    if (config.sessionId) this.sessionId = config.sessionId
    this.agentId = config.agentId
    this.chatSessionId = config.chatSessionId
  }

  private getRegistryKey(): string {
    const sessionPart = this.chatSessionId || 'default'
    const agentPart = this.agentId || 'default'
    return `opencode:${sessionPart}:${agentPart}:${this.workDir}`
  }

  async *send(task: AgentTask): AsyncIterable<StreamChunk> {
    const key = this.getRegistryKey()

    // Build prompt with context and attachment file references
    let fullPrompt = task.context
      ? `Context:\n${task.context}\n\n---\n\n${task.prompt}`
      : task.prompt

    if (task.attachments && task.attachments.length > 0) {
      const fileList = task.attachments.map(a => `- ${a.filename}: ${a.path}`).join('\n')
      fullPrompt = `用户附带了以下文件：\n${fileList}\n\n---\n\n${fullPrompt}`
    }

    // Build CLI args
    const args = ['run', '--format', 'json', '--dir', this.workDir]
    if (this.config.model) args.push('--model', this.config.model)
    if (task.systemPrompt) args.push('--prompt', task.systemPrompt)
    if (this.sessionId) args.push('--session', this.sessionId)

    // Build env with provider config
    const env: Record<string, string> = {
      OPENCODE_PERMISSION: '{"*":"allow"}',
    }
    if (this.config.apiKey) {
      env.ANTHROPIC_API_KEY = this.config.apiKey
      env.OPENAI_API_KEY = this.config.apiKey
    }
    if (this.config.baseUrl) {
      env.ANTHROPIC_BASE_URL = this.config.baseUrl
      env.OPENAI_BASE_URL = this.config.baseUrl
    }

    // 通过 ProcessRegistry 执行（获得重试 + 超时 + 清理能力）
    const spawnConfig = {
      workDir: this.workDir,
      command: 'opencode',
      args,
      format: 'ndjson' as const,
      env,
    }

    for await (const chunk of processRegistry.send(key, fullPrompt, spawnConfig)) {
      if (chunk.type === 'session') {
        this.sessionId = chunk.content
      }
      yield chunk
    }
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  async close(): Promise<void> {
    // ProcessRegistry 的 ndjson 格式在 send() 后自动清理，无需手动 kill
  }
}

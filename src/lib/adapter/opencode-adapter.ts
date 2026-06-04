import { join } from 'path'
import type { AgentAdapter, AdapterConfig, AgentTask, StreamChunk } from './types'
import { processRegistry } from './process-registry'

export class OpenCodeAdapter implements AgentAdapter {
  private config: AdapterConfig = { platform: 'opencode' }
  private workDir: string = ''
  private sessionId: string | null = null
  private agentId: string | undefined
  private chatSessionId: string | undefined
  private allowedTools: string[] | undefined

  async connect(config: AdapterConfig): Promise<void> {
    this.config = config
    this.workDir = config.workDir || join(process.cwd(), 'workspaces', `opencode-${Date.now()}`)
    if (config.sessionId) this.sessionId = config.sessionId
    this.agentId = config.agentId
    this.chatSessionId = config.chatSessionId
    this.allowedTools = config.allowedTools
  }

  private getRegistryKey(): string {
    const sessionPart = this.chatSessionId || 'default'
    const agentPart = this.agentId || 'default'
    return `opencode:${sessionPart}:${agentPart}:${this.workDir}`
  }

  async *send(task: AgentTask): AsyncIterable<StreamChunk> {
    const key = this.getRegistryKey()

    // Build prompt: systemPrompt 拼接到消息中（opencode run 不支持 --prompt 标志）
    const parts: string[] = []
    if (task.systemPrompt) parts.push(task.systemPrompt)
    if (task.context) parts.push(`Context:\n${task.context}`)

    if (task.attachments && task.attachments.length > 0) {
      const fileList = task.attachments.map(a => `- ${a.filename}: ${a.path}`).join('\n')
      parts.push(`用户附带了以下文件：\n${fileList}`)
    }

    parts.push(task.prompt)
    const fullPrompt = parts.join('\n\n---\n\n')

    // Build CLI args: opencode 无子命令，直接用根命令标志
    // -p 触发非交互模式（prompt 通过 stdin 传递，与 Claude Code 一致）
    const args = ['-p', '-f', 'json', '-c', this.workDir]
    if (this.config.model) args.push('--model', this.config.model)
    if (this.sessionId) args.push('--session', this.sessionId)

    // Build env with provider config
    const env: Record<string, string> = {}
    // 有工具限制时不设 OPENCODE_PERMISSION，避免覆盖 OPENCODE_CONFIG 的限制配置
    if (!this.allowedTools || this.allowedTools.length === 0) {
      env.OPENCODE_PERMISSION = '{"*":"allow"}'
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
      allowedTools: this.allowedTools,
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

import type { ChildProcess } from 'child_process'
import { readFileSync } from 'fs'
import type { AgentAdapter, AdapterConfig, AgentTask, StreamChunk } from './types'
import { processRegistry, type SpawnConfig } from './process-registry'
import { ensureClaudeConfigDir, claudeEnvScrub } from './claude-code-env'

// 默认工作目录：项目的 workspaces 目录（在 Claude Code 允许范围内）
const DEFAULT_WORK_DIR = process.cwd()

export class ClaudeCodeAdapter implements AgentAdapter {
  private workDir: string = ''
  private sessionId: string | null = null
  private permissionMode: string = 'default'
  private mcpConfig: string | undefined
  private agentId: string | undefined
  private chatSessionId: string | undefined
  private apiKey: string | undefined
  private baseUrl: string | undefined
  private model: string | undefined
  private allowedTools: string[] | undefined
  private disallowedTools: string[] | undefined
  // ❌-1 修复:send() 时缓存真正用于 spawn 的 SpawnConfig 对象引用
  // gracefulKillEntry 必须用这个快照才能算对 effectiveKey
  // (注:adapter.close() 时会清零此字段,避免 apiKey 残留)
  private lastSpawnConfig: SpawnConfig | null = null

  async connect(config: AdapterConfig): Promise<void> {
    this.workDir = config.workDir || DEFAULT_WORK_DIR
    this.sessionId = config.sessionId || null
    this.permissionMode = config.permissionMode || 'default'
    this.mcpConfig = config.mcpConfig
    this.agentId = config.agentId
    this.chatSessionId = config.chatSessionId
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl
    this.model = config.model
    this.allowedTools = config.allowedTools
    this.disallowedTools = config.disallowedTools
  }

  private getRegistryKeyInternal(): string {
    // Key format: chatSessionId:agentId:workDir
    // Falls back to workDir alone if session/agent not available
    const sessionPart = this.chatSessionId || 'default'
    const agentPart = this.agentId || 'default'
    return `${sessionPart}:${agentPart}:${this.workDir}`
  }

  /**
   * ❌-1 修复:暴露 registry key,orchestrator 不再自己拼 key
   */
  getRegistryKey(): string {
    return this.getRegistryKeyInternal()
  }

  /**
   * ❌-1 修复:返回最后一次 send() 时的完整 SpawnConfig 快照
   * send 之前调用返回 null
   */
  getSpawnConfig(): SpawnConfig | null {
    return this.lastSpawnConfig
  }

  async *send(task: AgentTask): AsyncIterable<StreamChunk> {
    const key = this.getRegistryKey()

    // Build full prompt (no context concatenation — CLI manages history via --resume)
    const parts: string[] = []
    if (task.systemPrompt) parts.push(task.systemPrompt)

    // Add non-image file references to prompt
    const nonImageAttachments = task.attachments?.filter(a => !a.mimeType.startsWith('image/')) || []
    if (nonImageAttachments.length > 0) {
      const fileList = nonImageAttachments.map(a => `- ${a.filename} (${a.path})`).join('\n')
      parts.push(`用户附带了以下文件，请使用 Read 工具读取：\n${fileList}`)
    }

    parts.push(task.prompt)
    const fullPrompt = parts.join('\n\n---\n\n')

    // Read image files for base64 embedding
    const imageAttachments = task.attachments
      ? task.attachments
          .filter(a => a.mimeType.startsWith('image/'))
          .map(a => {
            try {
              const fileData = readFileSync(a.path)
              return { mimeType: a.mimeType, data: fileData.toString('base64') }
            } catch (err) {
              console.warn(`[ClaudeCodeAdapter] Failed to read attachment ${a.path}: ${err}`)
              return null
            }
          })
          .filter((a): a is { mimeType: string; data: string } => a !== null)
      : []

    // Build spawn config for process rebuild on retry
    const spawnConfig: SpawnConfig = {
      workDir: this.workDir,
      sessionId: this.sessionId,
      permissionMode: this.permissionMode,
      mcpConfig: this.mcpConfig,
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      model: this.model,
      allowedTools: this.allowedTools,
      disallowedTools: this.disallowedTools,
    }

    // ISSUE-027 根治：claude -p 模式无视 env 注入的 ANTHROPIC_BASE_URL（CLI v2.1.270 实测，
    // 2026-09-27 讨论全灭根因），provider 配置改走受管 CLAUDE_CONFIG_DIR settings.json 通道；
    // env 注入仅作冗余。baseUrl/apiKey 缺失（如空配置 agent）→ ensure 返回 null → 维持旧行为。
    const cfgDir = ensureClaudeConfigDir({ baseUrl: this.baseUrl, apiKey: this.apiKey, model: this.model })
    if (cfgDir) {
      spawnConfig.env = { CLAUDE_CONFIG_DIR: cfgDir }
      spawnConfig.envScrub = claudeEnvScrub()
    }

    // Get or create process via registry
    const entry = processRegistry.getOrCreate(key, spawnConfig)
    // ❌-1 修复:spawn 成功后才缓存,避免 spawn 失败留下假 lastSpawnConfig
    // 导致 onTimeout 误报"effectiveKey miss"(实际是进程根本没起来)
    this.lastSpawnConfig = spawnConfig

    // Update sessionId from registry (in case process was resumed)
    if (entry.sessionId) {
      this.sessionId = entry.sessionId
    }

    // Yield chunks from registry (pass spawnConfig for retry rebuild)
    for await (const chunk of processRegistry.send(key, fullPrompt, spawnConfig, imageAttachments)) {
      // Capture session_id from session chunks
      if (chunk.type === 'session') {
        this.sessionId = chunk.content
      }
      yield chunk
    }
  }

  async close(): Promise<void> {
    // Phase 1: do nothing - process stays in registry for reuse
    // Idle cleanup will handle eventual termination
    // ❌-1 修复:清敏感快照,对齐 close 释放协议
    // (apiKey/baseUrl 不再被 getSpawnConfig() 返回)
    this.lastSpawnConfig = null
  }
}

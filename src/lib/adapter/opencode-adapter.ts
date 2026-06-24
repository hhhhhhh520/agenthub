import { join } from 'path'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import type { AgentAdapter, AdapterConfig, AgentTask, StreamChunk } from './types'
import { processRegistry, type SpawnConfig } from './process-registry'

export class OpenCodeAdapter implements AgentAdapter {
  private config: AdapterConfig = { platform: 'opencode' }
  private workDir: string = ''
  private sessionId: string | null = null
  private agentId: string | undefined
  private chatSessionId: string | undefined
  private allowedTools: string[] | undefined
  private permissionMode: string = 'default'
  // ❌-1 修复:send() 时缓存真正用于 spawn 的 SpawnConfig 对象引用
  // (注:adapter.close() 时会清零此字段)
  private lastSpawnConfig: SpawnConfig | null = null

  async connect(config: AdapterConfig): Promise<void> {
    this.config = config
    this.workDir = config.workDir || join(process.cwd(), 'workspaces', `opencode-${Date.now()}`)
    if (config.sessionId) this.sessionId = config.sessionId
    this.agentId = config.agentId
    this.chatSessionId = config.chatSessionId
    this.allowedTools = config.allowedTools
    this.permissionMode = config.permissionMode || 'default'
  }

  private getRegistryKeyInternal(): string {
    const sessionPart = this.chatSessionId || 'default'
    const agentPart = this.agentId || 'default'
    return `opencode:${sessionPart}:${agentPart}:${this.workDir}`
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

  /**
   * 将 systemPrompt 写入 .opencode/agents/agenthub-{agentId}.md
   * OpenCode 启动时自动加载该文件作为 agent 行为指令
   */
  private ensureAgentConfig(systemPrompt: string): void {
    if (!this.agentId || !this.workDir) return

    const agentDir = join(this.workDir, '.opencode', 'agents')
    const agentFile = join(agentDir, `agenthub-${this.agentId}.md`)

    const toolsYaml = this.buildToolsYaml()
    const content = `---\ndescription: AgentHub Agent\n${toolsYaml}---\n${systemPrompt}`

    // 检查是否需要更新（内容没变则跳过）
    try {
      const existing = readFileSync(agentFile, 'utf-8')
      if (existing === content) return
    } catch {
      // 文件不存在，需要创建
    }

    mkdirSync(agentDir, { recursive: true })
    writeFileSync(agentFile, content, 'utf-8')
  }

  /**
   * 将 MCP 配置写入 opencode.json（项目级配置）
   * OpenCode 启动时自动读取该文件作为 MCP server 配置
   * 返回 XDG_CONFIG_HOME 目录路径（用于环境变量注入）
   */
  private ensureMcpConfig(mcpConfig: string): string | undefined {
    if (!mcpConfig || !this.workDir) return undefined

    try {
      const config = JSON.parse(mcpConfig)
      const mcpServers: Record<string, unknown> = {}

      // 转换 Claude Code MCP 格式 → OpenCode MCP 格式
      if (config.mcpServers) {
        for (const [name, server] of Object.entries(config.mcpServers)) {
          const s = server as { command: string; args: string[]; env?: Record<string, string> }
          mcpServers[name] = {
            type: 'local',
            command: [s.command, ...s.args],
            environment: s.env || {},
            enabled: true,
          }
        }
      }

      if (Object.keys(mcpServers).length === 0) return undefined

      // 使用 XDG_CONFIG_HOME 隔离每个 Agent 的配置（避免并发冲突）
      const configDir = join(tmpdir(), `agenthub-oc-${this.agentId || 'default'}-${Date.now()}`)
      const opencodeDir = join(configDir, 'opencode')
      mkdirSync(opencodeDir, { recursive: true })

      // 读取全局配置（providers 等）并合并 MCP 配置
      let globalConfig: Record<string, unknown> = {}
      try {
        const globalConfigPath = join(process.env.HOME || process.env.USERPROFILE || '', '.config', 'opencode', 'opencode.json')
        globalConfig = JSON.parse(readFileSync(globalConfigPath, 'utf-8'))
      } catch {
        // 全局配置不存在，只用 MCP 配置
      }

      const mergedConfig = { ...globalConfig, mcp: mcpServers }
      writeFileSync(join(opencodeDir, 'opencode.json'), JSON.stringify(mergedConfig, null, 2), 'utf-8')

      return configDir
    } catch (err) {
      console.error('[OpenCodeAdapter] Failed to write MCP config:', err)
      return undefined
    }
  }

  /**
   * 将 allowedTools 映射为 OpenCode agent 配置的 tools YAML 字段
   * 只在有限制时写入（空 allowedTools 时用 OPENCODE_PERMISSION 环境变量全部放行）
   */
  private buildToolsYaml(): string {
    if (!this.allowedTools || this.allowedTools.length === 0) return ''

    // AgentHub 工具名 → OpenCode 工具名映射
    const TOOL_MAP: Record<string, string> = {
      'Read': 'read',
      'Write': 'write',
      'Edit': 'edit',
      'Bash': 'bash',
      'Glob': 'glob',
      'Grep': 'grep',
      'WebFetch': 'webfetch',
      'Agent': 'task',
    }

    const lines = ['tools:']
    for (const [hubTool, ocTool] of Object.entries(TOOL_MAP)) {
      const allowed = this.allowedTools.includes(hubTool)
      lines.push(`  ${ocTool}: ${allowed}`)
    }
    return lines.join('\n') + '\n'
  }

  async *send(task: AgentTask): AsyncIterable<StreamChunk> {
    const key = this.getRegistryKey()

    // System Prompt 写入 agent 配置文件，不拼接到 prompt
    // 即使 systemPrompt 为空也要更新（tools 可能变化）
    this.ensureAgentConfig(task.systemPrompt || '')

    // 只传用户消息（systemPrompt 已通过 agent 配置文件注入）
    const fullPrompt = task.prompt

    // 构建 CLI 参数
    const args = ['run', '--format', 'json']
    if (this.agentId) args.push('--agent', `agenthub-${this.agentId}`)
    if (this.sessionId) args.push('--session', this.sessionId)
    if (this.config.model) args.push('--model', this.config.model)
    if (this.workDir) args.push('--dir', this.workDir)
    if (this.permissionMode === 'auto') args.push('--dangerously-skip-permissions')

    // 附件：通过 --file 参数传递（图片和非图片都走 --file）
    if (task.attachments && task.attachments.length > 0) {
      for (const att of task.attachments) {
        if (existsSync(att.path)) {
          args.push('--file', att.path)
        }
      }
    }

    // 构建环境变量（参照 cc-connect：用 ANTHROPIC_API_KEY）
    const env: Record<string, string> = {}
    if (!this.allowedTools || this.allowedTools.length === 0) {
      env.OPENCODE_PERMISSION = '{"*":"allow"}'
    }
    if (this.config.apiKey) {
      env.ANTHROPIC_API_KEY = this.config.apiKey
    }
    if (this.config.baseUrl) {
      env.ANTHROPIC_BASE_URL = this.config.baseUrl
    }
    // 三重锚定：PWD 环境变量确保 OpenCode 正确发现 .opencode/ 目录
    // 参照 multica 方案（MUL-2416 bug fix）
    if (this.workDir) {
      env.PWD = this.workDir
    }

    // MCP 配置：通过 XDG_CONFIG_HOME 注入（每个 Agent 独立配置目录，避免并发冲突）
    if (this.config.mcpConfig) {
      const configDir = this.ensureMcpConfig(this.config.mcpConfig)
      if (configDir) {
        env.XDG_CONFIG_HOME = configDir
      }
    }

    const spawnConfig: SpawnConfig = {
      workDir: this.workDir,
      command: 'opencode',
      args,
      format: 'ndjson' as const,
      env,
      allowedTools: this.allowedTools,
      shell: true,
    }

    // ❌-1 修复:在第一个 chunk 抵达后才缓存 spawnConfig
    // 这样 spawn 失败(generator 第一帧就 throw)时不会留下假 lastSpawnConfig,
    // 避免 onTimeout 误报"effectiveKey miss"(实际是进程根本没起来)
    let cachedSpawnConfig = false
    for await (const chunk of processRegistry.send(key, fullPrompt, spawnConfig)) {
      if (!cachedSpawnConfig) {
        this.lastSpawnConfig = spawnConfig
        cachedSpawnConfig = true
      }
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
    // ProcessRegistry 的 ndjson 格式在 send() 后自动清理
    // ❌-1 修复:清敏感快照,对齐 close 释放协议
    this.lastSpawnConfig = null
  }
}

import { join } from 'path'
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { createHash } from 'node:crypto'
import type { AgentAdapter, AdapterConfig, AgentTask, StreamChunk } from './types'
import { processRegistry, type SpawnConfig } from './process-registry'
import { claudeEnvScrub } from './claude-code-env'

/**
 * ISSUE-027 commit 3：opencode provider 配置文件生成。
 *
 * 根因链（2026-09-29 活体实测）：tokenrhythm 网关拒收 claude CLI 固化携带的
 * anthropic-beta: interleaved-thinking 头 → claude-code adapter 不可用；opencode 的
 * **env 注入路径**（ANTHROPIC_API_KEY/BASE_URL）同样触发该 beta 头（opencode 检测到
 * anthropic env 时启用 Claude-Code 兼容 betas，实测 400 同文案）；**配置文件显式
 * provider options 路径实测通过**（SMOKE-OK）。故有 apiKey+baseUrl 的 agent 改为生成
 * opencode 配置文件（XDG_CONFIG_HOME/opencode/opencode.json），env 注入退役。
 *
 * 注意 baseUrl 语义：SDK 在 baseURL 后追加 /messages，**opencode 平台的 baseUrl 须带
 * /v1**（与 claude-code 平台的裸域名不同，换平台须同步改 DB）。
 */

/** 与 process-registry 的 model 清洗同款：括号后缀不参与身份 */
function cleanModel(model?: string): string {
  return (model || '').replace(/\[.*?\]/g, '')
}

/**
 * agentId → 稳定 XDG 目录名（hash 化）。审查 🟡：讨论路径 agentId=用户自起名（中文名/
 * 含 ../.. 等）直接拼目录会路径逃逸且明文 key 落点不可控——对齐 claude 路径「目录名只含
 * hash」拍板。sweep 同款映射见 claude-cfg-maintenance.ts。
 */
export function opencodeCfgDirName(agentId: string): string {
  return 'agenthub-oc-' + createHash('sha256').update(agentId).digest('hex').slice(0, 12)
}

/** opencode 平台的 baseUrl scheme 校验（与 claude-code-env.assertSafeBaseUrl 同规则） */
function assertSafeBaseUrl(baseUrl: string): void {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error(`AGENTHUB: agent baseUrl 无法解析为 URL，拒绝写入 opencode 配置: ${JSON.stringify(baseUrl.slice(0, 60))}`)
  }
  if (url.protocol === 'https:') return
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1'
  if (url.protocol === 'http:' && loopback) return
  throw new Error(`AGENTHUB: agent baseUrl 必须为 https 或 http 回环地址（明文凭据保护），实际: ${url.protocol}//${url.hostname}`)
}

/**
 * 生成 opencode 配置文件的 provider 部分（provider/model/small_model）。
 * baseUrl/apiKey 任一缺失 → null（走 env 旧路径）；scheme 非法 → throw（明文凭据保护）。
 * 小模型（会话标题等影子调用）显式指向同一模型——防网关上不存在的 claude-haiku 报错
 * （实测：tokenrhythm 对 claude-haiku-4-5-20251001 返回「模型不可用」）。
 */
export function buildOpencodeProviderConfig(cfg: { baseUrl?: string; apiKey?: string; model?: string }): Record<string, unknown> | null {
  if (!cfg.baseUrl || !cfg.apiKey) return null
  assertSafeBaseUrl(cfg.baseUrl)
  // 剥可能已带的 provider 前缀（审查 🟡：'mimo/mimo-x' 形态会双重前缀成不可解析模型）
  const raw = cleanModel(cfg.model)
  if (!raw) return null
  const model = raw.includes('/') ? raw.split('/').pop()! : raw
  // /v1 语义提示（审查 🟢）：opencode SDK 在 baseURL 后直拼 /messages，裸域名会静默 404——
  // 不强改（某些网关路径不同），只告警提示换平台须同步改 DB
  if (urlPathOf(cfg.baseUrl) === '') {
    console.warn(`[OpenCodeAdapter] baseUrl 无路径（裸域名）：opencode SDK 将请求 ${cfg.baseUrl}/messages——多数网关需带 /v1 后缀，请核对 Agent.baseUrl`)
  }
  return {
    provider: {
      anthropic: {
        options: { baseURL: cfg.baseUrl, apiKey: cfg.apiKey },
        models: { [model]: {} },
      },
    },
    model: `anthropic/${model}`,
    small_model: `anthropic/${model}`,
  }
}

function urlPathOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).pathname.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

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
   * 将 MCP 配置（Claude Code 格式）转换为 OpenCode mcp 字段。
   * 无有效 server 时返回空对象。
   */
  private parseMcpServers(mcpConfig: string): Record<string, unknown> {
    const mcpServers: Record<string, unknown> = {}
    try {
      const config = JSON.parse(mcpConfig)
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
    } catch {
      // 配置损坏时不注入 mcp（fail-safe，与旧 ensureMcpConfig 等价）
    }
    return mcpServers
  }

  /**
   * ISSUE-027 commit 3：写 XDG 配置目录（provider 配置 + MCP 合并），返回 XDG_CONFIG_HOME 值。
   * - providerCfg 存在时覆盖 provider/model/small_model（配置文件路径，绕开 env 路径的
   *   anthropic-beta 头问题——见 buildOpencodeProviderConfig 注释）；
   * - 目录按 agentId hash 稳定（审查 🟡：原始 agentId 含中文/路径字符会逃逸；同时消除旧
   *   Date.now() 每-spawn 目录的 tmp 无界增长）；
   * - 内容读同跳过写 + tmp+rename 原子替换（对齐 claude 路径评审 #2 定式）；
   * - **fail-fast（审查 🟡）**：providerCfg 存在时写失败直接抛——静默降级会让 spawn 变
   *   零凭据 + 未注册模型的难查死相（envScrub 已剥掉继承凭据，无退路）；仅 mcp 时维持
   *   旧吞错语义（MCP 缺失不致命）。
   * 0o700/0o600：POSIX 有效；Windows 无 ACL 收紧效果，防护依赖 %TEMP% 的用户 profile ACL。
   */
  private ensureXdgConfig(providerCfg: Record<string, unknown> | null, mcpConfig?: string): string | undefined {
    const mcpServers = mcpConfig ? this.parseMcpServers(mcpConfig) : {}
    if (!providerCfg && Object.keys(mcpServers).length === 0) {
      return undefined // 无 provider 且无有效 MCP：不注入 XDG（恢复旧短路语义，防空壳遮蔽全局配置）
    }
    const configDir = join(tmpdir(), opencodeCfgDirName(this.agentId || 'default'))
    const opencodeDir = join(configDir, 'opencode')
    mkdirSync(opencodeDir, { recursive: true, mode: 0o700 })

    // 读取全局配置（providers 等）并合并
    let globalConfig: Record<string, unknown> = {}
    try {
      const globalConfigPath = join(process.env.HOME || process.env.USERPROFILE || '', '.config', 'opencode', 'opencode.json')
      globalConfig = JSON.parse(readFileSync(globalConfigPath, 'utf-8'))
    } catch {
      // 全局配置不存在，只用生成配置
    }

    const mergedConfig: Record<string, unknown> = {
      ...globalConfig,
      ...(providerCfg || {}),
      ...(Object.keys(mcpServers).length > 0 ? { mcp: mcpServers } : {}),
    }
    const content = JSON.stringify(mergedConfig, null, 2) + '\n'
    const target = join(opencodeDir, 'opencode.json')

    let existing: string | null = null
    try {
      existing = readFileSync(target, 'utf-8')
    } catch {
      // 不存在
    }
    if (existing === content) return configDir

    const tmp = join(opencodeDir, `.opencode.${process.pid}.${Date.now()}.tmp`)
    // 0o600：POSIX 生效；Windows 无 ACL 收紧（依赖 %TEMP% 的 profile ACL），配置内含明文 apiKey
    writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 })
    try {
      renameSync(tmp, target)
    } catch (err) {
      try { rmSync(tmp, { force: true }) } catch { /* sweep 兜底 */ }
      if (providerCfg) throw err // fail-fast：providerCfg 场景零凭据运行比显式失败更难查（审查 🟡）
      console.error('[OpenCodeAdapter] Failed to write opencode config:', err)
      return undefined
    }
    return configDir
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
    // ISSUE-027 commit 3：有 apiKey+baseUrl 时 provider 配置走生成的配置文件（env 路径触发
    // tokenrhythm 拒收的 anthropic-beta 头），模型引用带 provider 前缀；否则维持 env 旧路径
    const providerCfg = buildOpencodeProviderConfig({
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      model: this.config.model,
    })
    if (this.config.model) {
      args.push('--model', providerCfg ? `anthropic/${cleanModel(this.config.model)}` : this.config.model)
    }
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

    // 构建环境变量
    const env: Record<string, string> = {}
    if (!this.allowedTools || this.allowedTools.length === 0) {
      env.OPENCODE_PERMISSION = '{"*":"allow"}'
    }
    if (!providerCfg) {
      // 旧路径（无 apiKey/baseUrl 的 agent）：保留 env 注入（用户自配 opencode 场景）。
      // ⚠️ 有 provider 配置时必须跳过——env 的 ANTHROPIC_* 会触发 opencode 的
      // Claude-Code 兼容 beta 头（tokenrhythm 拒收，2026-09-29 实测）
      if (this.config.apiKey) {
        env.ANTHROPIC_API_KEY = this.config.apiKey
      }
      if (this.config.baseUrl) {
        env.ANTHROPIC_BASE_URL = this.config.baseUrl
      }
    }
    // 三重锚定：PWD 环境变量确保 OpenCode 正确发现 .opencode/ 目录
    // 参照 multica 方案（MUL-2416 bug fix）
    if (this.workDir) {
      env.PWD = this.workDir
    }

    // XDG 配置：provider 配置与/或 MCP 合并写入（每 Agent 稳定目录，避免并发冲突）
    const configDir = this.ensureXdgConfig(providerCfg, this.config.mcpConfig)
    if (configDir) {
      env.XDG_CONFIG_HOME = configDir
    }

    const spawnConfig: SpawnConfig = {
      workDir: this.workDir,
      command: 'opencode',
      args,
      format: 'ndjson' as const,
      env,
      // ISSUE-027：剥除继承的 ANTHROPIC_*/CLAUDE_*（如用户 shell 的 ark BASE_URL），
      // 凭据与端点只经生成的 XDG 配置文件传递（claude 路径同原则）
      envScrub: providerCfg ? claudeEnvScrub() : undefined,
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

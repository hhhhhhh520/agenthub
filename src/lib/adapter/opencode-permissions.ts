/**
 * OpenCode 权限模型（v2.0.27 CLI 探针，2026-10-20）
 *
 * 两个维度：
 * - **可用工具**：agent frontmatter 的 `tools`（true/false）——不在此列表的工具不可用；
 * - **审批**：agent frontmatter 的 `permission`（ask/allow/deny）——`--auto` 自动批准 ask，
 *   deny 永远拒绝。
 *
 * 关键实测结论：
 * - `OPENCODE_CONFIG` / `OPENCODE_PERMISSION` 在 v2.0.27 **不生效**，不能作为权限通道；
 * - `opencode run` 无 TTY 时遇到 `ask` 会 auto-reject（stderr: permission requested...
 *   auto-rejecting），没有可用的前端确认协议——因此 default 模式只能实现“只读”：
 *   读/搜索放行，写/执行/联网 ask（实际被 CLI 拒绝）；需要写操作请切 auto；
 * - `--auto` 只自动批准非 deny 的请求，deny 仍生效（工具级硬边界）。
 *
 * 本模块是纯函数，输出 agent md frontmatter；不写盘、不碰进程。
 */

/** AgentHub 工具名 → OpenCode 权限/工具键（OpenCode edit 同时覆盖 write/apply_patch） */
export const OPENCODE_TOOL_MAP: Record<string, string> = {
  Read: 'read',
  Write: 'edit',
  Edit: 'edit',
  Bash: 'bash',
  Glob: 'glob',
  Grep: 'grep',
  List: 'list',
  Agent: 'task',
  Task: 'task',
  Skill: 'skill',
  LSP: 'lsp',
  WebFetch: 'webfetch',
  WebSearch: 'websearch',
  AskUserQuestion: 'question',
  TodoWrite: 'todowrite',
  Execute: 'execute',
}

/** 默认模式下无需写权限即可放行的工具（只读/内部状态） */
const DEFAULT_READONLY_TOOLS = new Set(['read', 'glob', 'grep', 'list', 'todowrite'])

/** OpenCode agent frontmatter 支持的工具/权限键（含 v2 新 execute/list/external_directory） */
export const OPENCODE_ALL_TOOLS = [
  'read', 'edit', 'glob', 'grep', 'list', 'bash', 'task', 'skill', 'lsp',
  'webfetch', 'websearch', 'question', 'todowrite', 'external_directory', 'execute',
] as const

export type OpenCodePermissionEffect = 'allow' | 'ask' | 'deny'

/** AgentHub Bash 同时授予 OpenCode v2 的 bash/shell 与 execute 代码执行能力 */
function expandAllowedTools(allowedTools: string[] | undefined): Set<string> {
  const available = new Set<string>()
  for (const t of allowedTools || []) {
    available.add(OPENCODE_TOOL_MAP[t] || t.toLowerCase())
    if (t === 'Bash' || t === 'bash') available.add('execute')
  }
  return available
}

export interface OpenCodeAgentGrants {
  /** 可用工具（OpenCode 键） */
  available: Set<string>
  /** 每个工具的审批效果 */
  permission: Record<string, OpenCodePermissionEffect>
  /** 是否对工具集合做了限制（allowedTools 非空） */
  restricted: boolean
}

/**
 * allowedTools（AgentHub 工具名/OpenCode 键混合）→ OpenCode 权限。
 * - 空列表 = 不限制可用工具；default 仍只放行只读工具，auto 全放行；
 * - 非空列表 = 未列出的工具 deny（可用性 + 审批双保险）。
 */
export function buildOpenCodeGrants(
  allowedTools: string[] | undefined,
  permissionMode: string | undefined,
): OpenCodeAgentGrants {
  const restricted = !!allowedTools && allowedTools.length > 0
  const available = expandAllowedTools(allowedTools)

  const auto = permissionMode === 'auto'
  const permission: Record<string, OpenCodePermissionEffect> = {}
  for (const tool of OPENCODE_ALL_TOOLS) {
    if (restricted && !available.has(tool)) {
      permission[tool] = 'deny'
    } else if (auto) {
      permission[tool] = 'allow'
    } else if (DEFAULT_READONLY_TOOLS.has(tool)) {
      permission[tool] = 'allow'
    } else {
      permission[tool] = 'ask'
    }
  }
  return { available, permission, restricted }
}

/** agent frontmatter tools 块；空列表不写（不限制） */
export function buildOpenCodeToolsYaml(allowedTools: string[] | undefined): string {
  if (!allowedTools || allowedTools.length === 0) return ''
  const allowed = expandAllowedTools(allowedTools)
  const lines = ['tools:']
  for (const tool of OPENCODE_ALL_TOOLS) {
    lines.push(`  ${tool}: ${allowed.has(tool)}`)
  }
  return lines.join('\n') + '\n'
}

/** agent frontmatter permission 块；始终写，default = 只读，auto = 全放行（deny 仍保留） */
export function buildOpenCodePermissionYaml(
  allowedTools: string[] | undefined,
  permissionMode: string | undefined,
): string {
  const { permission } = buildOpenCodeGrants(allowedTools, permissionMode)
  const lines = ['permission:']
  for (const tool of OPENCODE_ALL_TOOLS) {
    if (tool === 'read' && permission[tool] === 'allow') {
      // 保留 OpenCode 默认的敏感文件读取审批；宽泛的 read allow 不能覆盖 .env ask。
      lines.push('  read:')
      lines.push('    "*": allow')
      lines.push('    "*.env": ask')
      lines.push('    "*.env.*": ask')
      lines.push('    "*.env.example": allow')
      continue
    }
    lines.push(`  ${tool}: ${permission[tool]}`)
  }
  return lines.join('\n') + '\n'
}

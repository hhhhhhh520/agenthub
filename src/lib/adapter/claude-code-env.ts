/**
 * ISSUE-027 根治：claude CLI 子进程的 provider 配置通道——settings.json 代替 spawn env。
 *
 * 根因（2026-09-28 八组活体实验，工单 issues/ISSUE-027-cli-env-channel-dead-401.md）：
 * claude.exe v2.1.270 `-p` 模式**无视进程 env 的 ANTHROPIC_BASE_URL**（把 env BASE_URL
 * 指向本地 HTTP 服务器零请求命中；清空全部相关 env 后请求仍落到用户级
 * ~/.claude/settings.json 声明的端点）。因此 process-registry 的 spawn env 注入
 * （ANTHROPIC_API_KEY/BASE_URL）对路由完全无效——子 CLI 实际打到用户 settings.json
 * 里的端点（本机为 ark），携带注入的第三方 key 被拒「The API key format is incorrect」，
 * 讨论路径 3min 预算内只见超时（2026-09-27 四+角色全灭的直接成因）。
 *
 * 唯一验证有效的通道：CLAUDE_CONFIG_DIR 下的 settings.json `env` 块
 * （p5 装置 40/40 有效 run 先例；本会话 F/F2 探针：受管 settings 分别抵达
 * aliyuncs/xfyun 并拿到各自的协议级错误指纹）。本模块生成并维护每份配置一个
 * 受管配置目录：~/.agenthub/claude-cfg/<sha256(baseUrl+apiKey+model)[:12]>/settings.json。
 *
 * 设计约束：
 * - 目录名只含 hash，不含 key/baseUrl 明文（评审拍板）。
 * - 同配置同目录 → CLI --resume 的 transcript 随目录延续；key/端点变更 → 新目录，
 *   旧目录由 sweepAgentClaudeConfigDirs 出清（生命周期完整性：create 同 PR 必写 cleanup）。
 * - 原子写 + 并发容忍（评审 #2）：读同跳过写；tmp+rename；EPERM/EEXIST 且现内容
 *   已等于目标内容时视为成功（Windows AV/索引器短暂锁文件的并发窗口）。
 * - baseUrl/apiKey 缺失 → 返回 null 走旧路径（如空配置 agent），不抛。
 * - ANTHROPIC_MODEL/SMALL_FAST_MODEL 显式写入 settings：防自定义网关上不存在的
 *   claude-haiku 影子调用（p5/讯飞配置同款先例）。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface ClaudeProviderConfig {
  baseUrl?: string
  apiKey?: string
  model?: string
}

export interface ClaudeCfgOptions {
  /** 测试注入根目录；默认 ~/.agenthub（评审拍板：home 目录天然在 git 外） */
  root?: string
}

/** 哨兵文件名：ensure 写入，sweep 只删含哨兵的 12-hex 目录（来源证明，攻击者审查 🟡） */
export const SENTINEL_FILE = '.agenthub-managed'

/** 与 process-registry buildConfigHash/model 清洗同款：括号后缀不参与身份 */
function cleanModel(model?: string): string {
  return (model || '').replace(/\[.*?\]/g, '')
}

function defaultRoot(): string {
  return process.env.AGENTHUB_CLAUDE_CFG_ROOT || join(homedir(), '.agenthub', 'claude-cfg')
}

/**
 * baseUrl 投递终点校验（攻击者审查 🟡）：settings.json 是 ANTHROPIC_AUTH_TOKEN（明文凭据）的
 * 权威投递终点——拒绝把鉴权头发往非 https / 非回环目标（http 明文可被链路窃听）。
 * 回环 http 放行以兼容本地协议桥（p5 local-anthropic-bridge 场景）。
 */
function assertSafeBaseUrl(baseUrl: string): void {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error(`AGENTHUB: agent baseUrl 无法解析为 URL，拒绝写入受管配置: ${JSON.stringify(baseUrl.slice(0, 60))}`)
  }
  if (url.protocol === 'https:') return
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1'
  if (url.protocol === 'http:' && loopback) return
  throw new Error(`AGENTHUB: agent baseUrl 必须为 https 或 http 回环地址（明文凭据保护），实际: ${url.protocol}//${url.hostname}`)
}

/** settings.json env 块内容；baseUrl/apiKey 任一缺失 → null（保留旧路径） */
export function claudeSettingsEnv(cfg: ClaudeProviderConfig): Record<string, string> | null {
  if (!cfg.baseUrl || !cfg.apiKey) return null
  assertSafeBaseUrl(cfg.baseUrl)
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: cfg.baseUrl,
    ANTHROPIC_AUTH_TOKEN: cfg.apiKey,
  }
  const model = cleanModel(cfg.model)
  if (model) {
    env.ANTHROPIC_MODEL = model
    env.ANTHROPIC_SMALL_FAST_MODEL = model
  }
  return env
}

/** 配置 → 受管配置目录路径（纯派生，无 fs）；baseUrl/apiKey 缺失 → null */
export function claudeConfigDir(cfg: ClaudeProviderConfig, opts?: ClaudeCfgOptions): string | null {
  if (!cfg.baseUrl || !cfg.apiKey) return null
  // JSON.stringify 三元组：裸 \n 拼接可被含换行的 baseUrl 构造碰撞（审查 🟢），序列化封死
  const hash = createHash('sha256')
    .update(JSON.stringify([cfg.baseUrl, cfg.apiKey, cleanModel(cfg.model)]))
    .digest('hex')
    .slice(0, 12)
  return join(opts?.root ?? defaultRoot(), hash)
}

/**
 * 确保受管配置目录存在且 settings.json 内容正确；返回目录路径（或 null 走旧路径）。
 * 写策略（评审 #2）：内容相同跳过写；否则 tmp+rename 原子替换；
 * rename 撞 EPERM/EEXIST 时若现文件内容已等于目标内容则容忍（并发首启窗口）。
 */
export function ensureClaudeConfigDir(cfg: ClaudeProviderConfig, opts?: ClaudeCfgOptions): string | null {
  const env = claudeSettingsEnv(cfg)
  if (!env) return null
  const dir = claudeConfigDir(cfg, opts)!
  const target = join(dir, 'settings.json')
  const content = JSON.stringify({ env }, null, 2) + '\n'

  mkdirSync(dir, { recursive: true, mode: 0o700 })

  // 哨兵（攻击者审查 🟡）：标记「本工具创建」——sweep 只删带哨兵的目录，12-hex 名字形态
  // 相同的第三方/手工目录零删除面
  const sentinel = join(dir, SENTINEL_FILE)
  if (!existsSync(sentinel)) {
    writeFileSync(sentinel, 'ISSUE-027 managed by agenthub\n', { encoding: 'utf-8', mode: 0o600 })
  }

  let existing: string | null = null
  try {
    existing = readFileSync(target, 'utf-8')
  } catch {
    /* 不存在 */
  }
  if (existing === content) return dir

  const tmp = join(dir, `.settings.${process.pid}.${Date.now()}.tmp`)
  // 0o600：settings.json 内含明文 key，收紧到仅属主可读（Windows 下映射为 ACL 收紧的尽力而为）
  try {
    writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 })
  } catch (err) {
    // ENOSPC/EACCES 等：清掉半成品 tmp（内含明文 key）再上抛（生命周期审查 🟡2.1）
    try { rmSync(tmp, { force: true }) } catch { /* 残留由 sweep 的 tmp 出清兜底 */ }
    throw err
  }
  try {
    renameSync(tmp, target)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* best-effort */
    }
    let now: string | null = null
    try {
      now = readFileSync(target, 'utf-8')
    } catch {
      /* 仍不存在 */
    }
    if (now === content) return dir // 并发对手已写入同内容（评审 #2 容忍分支）
    throw err
  }
  return dir
}

/**
 * 生命周期出清（评审 #1）：删除 root 下不在 activeDirs 集合内的配置目录。
 * key/端点每轮换一次会产生新目录，旧目录内含明文 key——不清理即无界增长 + 凭据残留。
 * 删除三重护栏（安全审查 🔴 + 攻击者审查 🟡）：
 * - 只考虑名字恰为 12 位 hex（本模块 hash 形态）的目录——root 被误配（AGENTHUB_CLAUDE_CFG_ROOT
 *   指向用户关键路径）时删除面收敛到 12-hex 命名空间；
 * - 且必须含本工具哨兵文件（SENTINEL_FILE）——第三方/手工创建的同形目录零删除面；
 * - 逐条 try/catch + 外层 try/catch 永不抛（best-effort，返回已删清单）。
 * 调用契约：调用方必须在「数据源查询成功」之后调用（route/instrumentation 的 try/catch
 * 保证，见 sweepWithCurrentConfigs）——此时空 active 集合 = 「确实零配置」为真，可安全
 * 出清带哨兵的残留目录（最后删除唯一带 key agent 的场景，攻击者审查 🟡）。
 * 附带出清 active 目录内 >1h 的半成品 .settings.*.tmp（写入/rename 失败或崩溃窗口遗留，
 * 内含明文 key，生命周期审查 🟡2.3）。
 */
export function sweepAgentClaudeConfigDirs(activeDirs: string[], opts?: ClaudeCfgOptions): string[] {
  const root = opts?.root ?? defaultRoot()
  const active = new Set(activeDirs.map(p => resolve(p)))
  const removed: string[] = []
  try {
    const entries = readdirSync(root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!/^[0-9a-f]{12}$/.test(entry.name)) continue // 非 12-hex hash 形态一律不删（安全审查 🔴 护栏）
      const full = resolve(root, entry.name)
      if (active.has(full)) {
        sweepStaleTmpFiles(full)
        continue
      }
      if (!existsSync(join(full, SENTINEL_FILE))) continue // 无哨兵 = 非本工具创建，不删
      try {
        rmSync(full, { recursive: true, force: true })
        removed.push(full)
      } catch {
        /* best-effort：被占用的目录留待下次 sweep */
      }
    }
  } catch {
    return removed // root 尚未创建 = 无可清理；读失败同样按空处理
  }
  return removed
}

/** 出清目录内残留的半成品 tmp（内含明文 key）；>1h 才删，避开并发写入中的 tmp */
function sweepStaleTmpFiles(dir: string): void {
  try {
    for (const f of readdirSync(dir)) {
      if (!/^\.settings\.\d+\.\d+\.tmp$/.test(f)) continue
      const fp = join(dir, f)
      try {
        if (Date.now() - statSync(fp).mtimeMs > 60 * 60 * 1000) rmSync(fp, { force: true })
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}

/**
 * spawn env 清洗清单（claude 路径，安全审查后对齐 p5 scrubInheritedProviderEnv）：
 * - ANTHROPIC_* / CLAUDE_ 前缀全剥：env 通道对 claude -p 无效（模块头注释），剥除后由
 *   providerEnv/config.env 按受管配置重建，防用户 shell 里的旧 ANTHROPIC_*（如
 *   AUTH_TOKEN=ark）与新配置不一致造成双头鉴权混乱（p5 ISSUE-013 同款教训）。
 *   CLAUDE_CONFIG_DIR 本身也被前缀剥除，但由 config.env 在 composeSpawnEnv 中后置覆盖。
 * - 精确键兜底：CLAUDECODE（无下划线，不匹配 CLAUDE_ 前缀）与 AI_AGENT；
 *   其余 CLAUDE_CODE_* 键为冗余自文档（已被前缀覆盖），保留以显式宣示意图。
 */
export const SCRUB_ENV_PREFIXES: readonly string[] = ['ANTHROPIC_', 'CLAUDE_']
export const SCRUB_ENV_EXACT: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'AI_AGENT',
]

/** 便捷打包：adapter 接线用的 envScrub 字段值 */
export function claudeEnvScrub(): { prefixes: string[]; exact: string[] } {
  return { prefixes: [...SCRUB_ENV_PREFIXES], exact: [...SCRUB_ENV_EXACT] }
}

/** CLI 合成错误文本的前缀签名（v2.1.270 实测两种死相，issues/ISSUE-027） */
export const CLI_SYNTHETIC_ERROR_PREFIXES: readonly string[] = [
  'Failed to authenticate. API Error:',
  "There's an issue with the selected model",
]

/**
 * CLI 合成错误判定（orchestrator 收口「错误文本被当 LLM 回复消费」——09-27 聊天假成功死相）。
 * 三重判据（评审 #3 长度上限 + 攻击者审查 F1 CJK 放行）：
 * - trim 后以前缀开头；
 * - 长度 <300（实测两形态 ~110/~180 字符）；
 * - **不含 CJK 字符**——CLI 合成错误是纯 ASCII 单行；讨论提示词限「200 字以内」（汉字
 *   ≈200 code units < 300），长度防线在讨论路径天然失效，skipMsg 错误文本回灌下一轮后
 *   健康 agent 以引用错误开头作答会被误拦成片传染——CJK 放行比长度更强的形态判别。
 */
const CLI_SYNTHETIC_MAX_LEN = 300
const CJK_RE = /[一-鿿]/

export function looksLikeCliSyntheticError(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t || t.length >= CLI_SYNTHETIC_MAX_LEN) return false
  if (CJK_RE.test(t)) return false // 含中文 = 人话回复，CLI 合成错误恒纯 ASCII（攻击者审查 F1）
  const lower = t.toLowerCase()
  return CLI_SYNTHETIC_ERROR_PREFIXES.some(p => lower.startsWith(p.toLowerCase()))
}

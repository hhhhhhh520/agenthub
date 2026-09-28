import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── ISSUE-027 根治：claude CLI provider 配置走 settings.json 通道 ──
//
// 根因（2026-09-28 八组活体实验，详见 issues/ISSUE-027）：
// claude.exe v2.1.270 -p 模式无视进程 env 的 ANTHROPIC_BASE_URL（本地 HTTP 服务器
// 零请求实锤），请求落到用户级 ~/.claude/settings.json 的端点——spawn env 注入的
// provider 配置对路由完全无效。唯一可靠通道 = CLAUDE_CONFIG_DIR 下的 settings.json
// env 块（p5 装置 40/40 有效 run 先例 + F/F2 探针验证）。
//
// 变异锚点：
//   - 去掉 ensureClaudeConfigDir 的写入逻辑 → 落盘/幂等/并发用例红
//   - sweep 误删 active/无哨兵目录 → sweep 用例红（评审 #1 + 攻击者审查哨兵方案）
//   - 去掉 baseUrl scheme 校验 → scheme 用例红（攻击者审查 🟡）
//   - rename-EPERM 容忍分支无自动化覆盖（同步函数单线程测不到竞态），见工单遗留段

import {
  claudeSettingsEnv,
  claudeConfigDir,
  ensureClaudeConfigDir,
  sweepAgentClaudeConfigDirs,
  SCRUB_ENV_PREFIXES,
  SCRUB_ENV_EXACT,
  type ClaudeProviderConfig,
} from '@/lib/adapter/claude-code-env'
import { composeSpawnEnv, isSessionNotFoundError } from '@/lib/adapter/process-registry'

const CFG: ClaudeProviderConfig = {
  baseUrl: 'https://tokenrhythm.studio',
  apiKey: 'sk_tr_test-key-0001',
  model: 'mimo-v2.6-flash',
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ah-claude-cfg-'))
}

describe('claudeSettingsEnv（settings.json env 块内容）', () => {
  it('映射 baseUrl/apiKey/model 四键，model 括号后缀剥离（与 registry --model 清洗一致）', () => {
    const env = claudeSettingsEnv({ ...CFG, model: 'qwen3.8-max-preview[1M]' })
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: 'https://tokenrhythm.studio',
      ANTHROPIC_AUTH_TOKEN: 'sk_tr_test-key-0001',
      ANTHROPIC_MODEL: 'qwen3.8-max-preview',
      ANTHROPIC_SMALL_FAST_MODEL: 'qwen3.8-max-preview',
    })
  })
  it('model 缺省 → 只含 BASE_URL/AUTH_TOKEN 两键（防自定义网关上不存在的 haiku 影子调用）', () => {
    const env = claudeSettingsEnv({ baseUrl: 'https://x', apiKey: 'k' })
    expect(Object.keys(env).sort()).toEqual(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'])
  })
  it('baseUrl 缺失 → null（保留旧路径，如 HelloAgentHub 空配置 agent）', () => {
    expect(claudeSettingsEnv({ apiKey: 'k', model: 'm' })).toBeNull()
  })
  it('apiKey 缺失 → null', () => {
    expect(claudeSettingsEnv({ baseUrl: 'https://x' })).toBeNull()
  })
  it('🔴 scheme 校验（攻击者审查 🟡）：https 放行、http 回环放行、其余拒绝（明文凭据保护）', () => {
    expect(() => claudeSettingsEnv({ baseUrl: 'https://any-gate.example', apiKey: 'k' })).not.toThrow()
    expect(() => claudeSettingsEnv({ baseUrl: 'http://127.0.0.1:8082', apiKey: 'k' })).not.toThrow()
    expect(() => claudeSettingsEnv({ baseUrl: 'http://localhost:3000', apiKey: 'k' })).not.toThrow()
    expect(() => claudeSettingsEnv({ baseUrl: 'http://evil.example/collect', apiKey: 'k' })).toThrow(/https/)
    expect(() => claudeSettingsEnv({ baseUrl: 'ftp://example.com', apiKey: 'k' })).toThrow(/https/)
    expect(() => claudeSettingsEnv({ baseUrl: 'not a url', apiKey: 'k' })).toThrow(/解析/)
  })
})

describe('claudeConfigDir（目录派生，纯路径无 fs）', () => {
  it('落在默认根 ~/.agenthub/claude-cfg 下', () => {
    const dir = claudeConfigDir(CFG)!
    expect(dir).toContain('.agenthub')
    expect(dir).toContain('claude-cfg')
  })
  it('确定性：同配置同目录', () => {
    expect(claudeConfigDir(CFG)).toBe(claudeConfigDir({ ...CFG }))
  })
  it('目录名只含 hash：不含 baseUrl 明文、不含 apiKey 任何片段', () => {
    const dir = claudeConfigDir(CFG)!
    const leaf = dir.split('claude-cfg')[1]!
    expect(leaf).not.toContain('tokenrhythm')
    expect(leaf).not.toContain('sk_tr')
    expect(leaf.replace(/[^a-f0-9]/g, '').length).toBeGreaterThanOrEqual(12)
  })
  it('不同 apiKey → 不同目录（key 轮换即换目录，配合 sweep 出清）', () => {
    expect(claudeConfigDir(CFG)).not.toBe(claudeConfigDir({ ...CFG, apiKey: 'sk_tr_other' }))
  })
  it('model 括号后缀不产生新目录（x[1m] 与 x 同目录）', () => {
    expect(claudeConfigDir({ ...CFG, model: 'm[1m]' })).toBe(claudeConfigDir({ ...CFG, model: 'm' }))
  })
  it('baseUrl/apiKey 缺失 → null', () => {
    expect(claudeConfigDir({ apiKey: 'k' })).toBeNull()
    expect(claudeConfigDir({ baseUrl: 'https://x' })).toBeNull()
  })
})

describe('ensureClaudeConfigDir（mkdir + 原子写 settings.json）', () => {
  it('创建目录并写入合法 settings.json', () => {
    const root = makeRoot()
    try {
      const dir = ensureClaudeConfigDir(CFG, { root })!
      expect(existsSync(join(dir, 'settings.json'))).toBe(true)
      const parsed = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8'))
      expect(parsed.env.ANTHROPIC_BASE_URL).toBe(CFG.baseUrl)
      expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe(CFG.apiKey)
      expect(parsed.env.ANTHROPIC_MODEL).toBe(CFG.model)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('幂等：重复调用内容稳定（读同跳过写）', () => {
    const root = makeRoot()
    try {
      const d1 = ensureClaudeConfigDir(CFG, { root })!
      const before = readFileSync(join(d1, 'settings.json'), 'utf-8')
      const d2 = ensureClaudeConfigDir(CFG, { root })!
      expect(d2).toBe(d1)
      expect(readFileSync(join(d2, 'settings.json'), 'utf-8')).toBe(before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('配置变更 → 同 root 下内容被更新为新配置', () => {
    const root = makeRoot()
    try {
      ensureClaudeConfigDir(CFG, { root })
      const dir = ensureClaudeConfigDir({ ...CFG, model: 'glm-5.3-flashx' }, { root })!
      expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8')).env.ANTHROPIC_MODEL).toBe('glm-5.3-flashx')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('重复调用幂等且结果合法（同线程下 Promise.all 串行执行，等价幂等路径）', async () => {
    // 注（设计审查 🟡5）：ensure 是全同步函数，单线程 Promise.all 无交错——本用例证明幂等，
    // 不覆盖 rename EPERM 容忍分支（claude-code-env.ts 的 catch 容忍路径）。该分支靠
    // 「rename 失败 && 现内容===目标」三段条件推演 + 真实并发首启场景守护；为此扭曲产线
    // 签名做注入不值得，见工单 ISSUE-027 遗留段。
    const root = makeRoot()
    try {
      const [a, b] = await Promise.all([
        ensureClaudeConfigDir(CFG, { root }),
        ensureClaudeConfigDir(CFG, { root }),
      ])
      expect(a).toBeTruthy()
      expect(b).toBeTruthy()
      expect(a).toBe(b)
      const parsed = JSON.parse(readFileSync(join(a!, 'settings.json'), 'utf-8'))
      expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe(CFG.apiKey)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('baseUrl/apiKey 缺失 → null 且不建任何子目录', () => {
    const base = makeRoot()
    try {
      const root = join(base, 'nested')
      expect(ensureClaudeConfigDir({ apiKey: 'k' }, { root })).toBeNull()
      expect(existsSync(root)).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('sweepAgentClaudeConfigDirs（生命周期出清，评审 #1 + 安全审查 🔴 护栏）', () => {
  it('删除不在 active 集合内的 12-hex 目录，保留 active；返回被删清单', () => {
    const root = makeRoot()
    try {
      const keep = ensureClaudeConfigDir(CFG, { root })!
      const staleA = ensureClaudeConfigDir({ ...CFG, apiKey: 'sk_tr_old-a' }, { root })!
      const staleB = ensureClaudeConfigDir({ ...CFG, apiKey: 'sk_tr_old-b' }, { root })!
      // 干扰项：root 下的普通文件不删
      const strayFile = join(root, 'README.txt')
      writeFileSync(strayFile, 'keep me', 'utf-8')
      const removed = sweepAgentClaudeConfigDirs([keep], { root })
      expect(existsSync(keep)).toBe(true)
      expect(existsSync(staleA)).toBe(false)
      expect(existsSync(staleB)).toBe(false)
      expect(existsSync(strayFile)).toBe(true)
      expect(removed).toContain(staleA)
      expect(removed).toContain(staleB)
      expect(removed).not.toContain(keep)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('🔴 非 12-hex 名形态的目录一律不删（root 误配/用户手工目录零删除面）', () => {
    const root = makeRoot()
    try {
      const keep = ensureClaudeConfigDir(CFG, { root })!
      const human = join(root, 'my-important-notes')
      const docs = join(root, 'a-very-long-directory-name-here')
      mkdirSync(human, { recursive: true })
      mkdirSync(docs, { recursive: true })
      const removed = sweepAgentClaudeConfigDirs([keep], { root })
      expect(existsSync(human)).toBe(true)
      expect(existsSync(docs)).toBe(true)
      expect(existsSync(keep)).toBe(true)
      expect(removed).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('🔴 哨兵护栏（攻击者审查 🟡）：同形 12-hex 但无哨兵的目录不删；空 active 只清带哨兵的自建目录', () => {
    const root = makeRoot()
    try {
      const own = ensureClaudeConfigDir(CFG, { root })! // ensure 写入哨兵
      const foreign = join(root, 'aaaaaaaaaaaa') // 12-hex 同形但无哨兵（第三方/手工）
      mkdirSync(foreign, { recursive: true })
      const removed = sweepAgentClaudeConfigDirs([], { root })
      expect(existsSync(foreign)).toBe(true)
      expect(existsSync(own)).toBe(false) // 空 active = 「确实零配置」为真（调用契约：数据源查询成功后才调）
      expect(removed).toEqual([own])
      expect(removed).not.toContain(foreign)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('root 不存在 → 空数组不抛（best-effort）', () => {
    const a = makeRoot()
    const b = makeRoot()
    try {
      expect(sweepAgentClaudeConfigDirs([join(a, 'whatever')], { root: join(b, 'nope') })).toEqual([])
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })
})

describe('SCRUB 清单（spawn env 清洗，防用户级 settings/会话 env 泄漏进子 CLI）', () => {
  it('前缀含 ANTHROPIC_ 与 CLAUDE_（对齐 p5 整段剥除；CLAUDE_CONFIG_DIR 由 config.env 后置覆盖）', () => {
    expect(SCRUB_ENV_PREFIXES).toContain('ANTHROPIC_')
    expect(SCRUB_ENV_PREFIXES).toContain('CLAUDE_')
  })
  it('精确键兜底 CLAUDECODE（无下划线不匹配前缀）与会话标识', () => {
    for (const k of ['CLAUDECODE', 'AI_AGENT', 'CLAUDE_PID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN']) {
      expect(SCRUB_ENV_EXACT).toContain(k)
    }
  })
})

describe('composeSpawnEnv（registry env 组合：scrub → providerEnv → config.env → 固定项）', () => {
  const inherited = {
    PATH: '/usr/bin',
    ANTHROPIC_AUTH_TOKEN: 'ark-stale-token',
    ANTHROPIC_BASE_URL: 'https://ark.cn-beijing.volces.com/api/plan',
    ANTHROPIC_MODEL: 'ark-code-latest[1m]',
    CLAUDECODE: '1',
    CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\cc-msg',
    GLM_API_KEY: 'keep-me',
  }
  const scrub = { prefixes: ['ANTHROPIC_'], exact: ['CLAUDECODE', 'CLAUDE_CODE_MESSAGING_SOCKET'] }

  it('envScrub 剥除 ANTHROPIC_* 与精确键，保留无关继承项', () => {
    const out = composeSpawnEnv(inherited, { workDir: '/w', envScrub: scrub }, {})
    expect(out.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(out.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(out.ANTHROPIC_MODEL).toBeUndefined()
    expect(out.CLAUDECODE).toBeUndefined()
    expect(out.CLAUDE_CODE_MESSAGING_SOCKET).toBeUndefined()
    expect(out.PATH).toBe('/usr/bin')
    expect(out.GLM_API_KEY).toBe('keep-me')
  })
  it('providerEnv 覆盖继承，config.env 覆盖 providerEnv，固定编码项always set', () => {
    const out = composeSpawnEnv(
      inherited,
      { workDir: '/w', envScrub: scrub, env: { CLAUDE_CONFIG_DIR: '/cfg/abc' } },
      { ANTHROPIC_API_KEY: 'sk_new', ANTHROPIC_BASE_URL: 'https://new.endpoint' },
    )
    expect(out.ANTHROPIC_API_KEY).toBe('sk_new')
    expect(out.ANTHROPIC_BASE_URL).toBe('https://new.endpoint')
    expect(out.CLAUDE_CONFIG_DIR).toBe('/cfg/abc')
    expect(out.PYTHONIOENCODING).toBe('utf-8')
    expect(out.LANG).toBe('en_US.UTF-8')
    expect(out.LC_ALL).toBe('en_US.UTF-8')
  })
  it('无 envScrub → 继承原样保留（opencode 路径零行为变化）', () => {
    const out = composeSpawnEnv(inherited, { workDir: '/w' }, {})
    expect(out.ANTHROPIC_AUTH_TOKEN).toBe('ark-stale-token')
    expect(out.CLAUDECODE).toBe('1')
  })
})

describe('isSessionNotFoundError（--resume 落空形态，ISSUE-027 换线后存量会话必撞）', () => {
  it('CLI "No conversation found with session ID: xxx" 命中', () => {
    expect(isSessionNotFoundError('No conversation found with session ID: abc-123')).toBe(true)
  })
  it('session not found 变体命中', () => {
    expect(isSessionNotFoundError('Error: session not found')).toBe(true)
  })
  it('普通错误不命中', () => {
    expect(isSessionNotFoundError('Process exited, code=1')).toBe(false)
    expect(isSessionNotFoundError('API Error: 401 The API key format is incorrect')).toBe(false)
  })
})

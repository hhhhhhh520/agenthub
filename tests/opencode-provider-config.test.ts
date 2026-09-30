import { describe, it, expect } from 'vitest'

// ── ISSUE-027 commit 3：opencode provider 配置文件生成 ──
//
// 根因链（2026-09-29 实测）：tokenrhythm 网关拒收 claude CLI 固化携带的
// anthropic-beta: interleaved-thinking 头 → claude-code adapter 不可用；
// opencode 的 **env 注入路径**（ANTHROPIC_API_KEY/BASE_URL）同样触发该 beta 头
// （opencode 检测到 anthropic env 时启用 Claude-Code 兼容 betas）；
// **配置文件显式 provider options 路径实测通过**（SMOKE-OK，4s）。
// 故 adapter 改为生成 opencode 配置文件（XDG_CONFIG_HOME/opencode/opencode.json），
// baseUrl 必须带 /v1（SDK 追加 /messages）。

import { buildOpencodeProviderConfig } from '@/lib/adapter/opencode-adapter'

describe('buildOpencodeProviderConfig（opencode 配置文件生成）', () => {
  it('生成 provider/model/small_model 三键，provider 固定 anthropic id，model 括号后缀剥离', () => {
    const cfg = buildOpencodeProviderConfig({
      baseUrl: 'https://tokenrhythm.studio/v1',
      apiKey: 'sk_test',
      model: 'mimo-v2.6-flash',
    })!
    expect(cfg.provider.anthropic.options).toEqual({
      baseURL: 'https://tokenrhythm.studio/v1',
      apiKey: 'sk_test',
    })
    expect(cfg.provider.anthropic.models).toEqual({ 'mimo-v2.6-flash': {} })
    expect(cfg.model).toBe('anthropic/mimo-v2.6-flash')
    expect(cfg.small_model).toBe('anthropic/mimo-v2.6-flash')
  })
  it('model 括号后缀剥离（qwen3.8-max[1M] 形态兼容）', () => {
    const cfg = buildOpencodeProviderConfig({
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      model: 'qwen3.8-max[1M]',
    })!
    expect(cfg.model).toBe('anthropic/qwen3.8-max')
  })
  it('已带 provider 前缀的 model 剥成裸名（防 anthropic/mimo/mimo-x 双前缀，审查 🟡）', () => {
    const cfg = buildOpencodeProviderConfig({
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      model: 'mimo/mimo-v2.5-pro',
    })!
    expect(cfg.model).toBe('anthropic/mimo-v2.5-pro')
    expect(cfg.provider.anthropic.models).toEqual({ 'mimo-v2.5-pro': {} })
  })
  it('🔴 scheme 校验：拒绝非 https/非回环 baseUrl（明文凭据保护，与 claude 通道同规则）', () => {
    expect(() => buildOpencodeProviderConfig({ baseUrl: 'http://evil.example', apiKey: 'k', model: 'm' })).toThrow(/https/)
    expect(() => buildOpencodeProviderConfig({ baseUrl: 'https://ok.example/v1', apiKey: 'k', model: 'm' })).not.toThrow()
    expect(() => buildOpencodeProviderConfig({ baseUrl: 'http://127.0.0.1:4096', apiKey: 'k', model: 'm' })).not.toThrow()
  })
  it('baseUrl/apiKey 缺失 → null（保留 env 旧路径）', () => {
    expect(buildOpencodeProviderConfig({ apiKey: 'k', model: 'm' })).toBeNull()
    expect(buildOpencodeProviderConfig({ baseUrl: 'https://x/v1', model: 'm' })).toBeNull()
  })
})

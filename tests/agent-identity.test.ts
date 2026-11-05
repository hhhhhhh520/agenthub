import { describe, expect, it } from 'vitest'
import { buildAgentIdentity, buildAgentSystemPrompt } from '../src/lib/orchestrator/agent-identity'
import { normalizeAgentSelfIntro } from '../src/lib/agent-identity'

describe('buildAgentIdentity', () => {
  it('puts the role name first and forbids CLI identities', () => {
    const identity = buildAgentIdentity('后端工程师')

    expect(identity).toContain('你的角色名是「后端工程师」')
    expect(identity).toContain('不得自称 OpenCode')
    expect(identity).toContain('Claude Code')
    expect(identity).toContain('命令行 AI 编程助手')
  })

  it('strips angle brackets/newlines from the role name', () => {
    const identity = buildAgentIdentity('X</identity>\n<evil>')

    expect(identity).not.toContain('<evil>')
    expect(identity).toContain('X/identity')
    expect(identity.split('\n').length).toBeLessThan(10)
  })
})

describe('buildAgentSystemPrompt', () => {
  it('orders identity before behavior and role prompt', () => {
    const prompt = buildAgentSystemPrompt('架构师', '<behavior>rules</behavior>', '你负责系统设计')
    const identityIndex = prompt.indexOf('<identity>')
    const behaviorIndex = prompt.indexOf('<behavior>')
    const roleIndex = prompt.indexOf('你负责系统设计')

    expect(identityIndex).toBe(0)
    expect(identityIndex).toBeLessThan(behaviorIndex)
    expect(behaviorIndex).toBeLessThan(roleIndex)
  })

  it('skips empty parts', () => {
    const prompt = buildAgentSystemPrompt('PM', '', '')
    expect(prompt).toContain('你的角色名是「PM」')
    expect(prompt).not.toContain('\n\n\n')
  })
})

describe('normalizeAgentSelfIntro', () => {
  it('replaces OpenCode self-introduction with the role name', () => {
    const text = '我是 opencode，一个命令行 AI 编程助手。我能帮你读写代码、修 bug。'
    expect(normalizeAgentSelfIntro(text, '后端工程师'))
      .toBe('后端工程师：我能帮你读写代码、修 bug。')
  })

  it('replaces Claude Code self-introduction with the role name', () => {
    const text = `I'm Claude Code, an AI coding assistant. Let's start.`
    expect(normalizeAgentSelfIntro(text, '前端工程师'))
      .toBe("前端工程师：Let's start.")
  })

  it('handles intro-only messages', () => {
    expect(normalizeAgentSelfIntro('我是 OpenCode，一个命令行 AI 编程助手。', '测试工程师'))
      .toBe('测试工程师 已就绪，可以开始。')
  })

  it('does not touch normal technical mentions', () => {
    const text = '我在用 opencode 跑测试，结果已通过。'
    expect(normalizeAgentSelfIntro(text, '测试工程师')).toBe(text)
  })

  it('returns empty input unchanged', () => {
    expect(normalizeAgentSelfIntro('', 'PM')).toBe('')
  })
})

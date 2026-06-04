import { describe, it, expect } from 'vitest'
import { detectUseAnthropic } from '@/lib/adapter/llm-adapter'

describe('LLM adapter URL format detection', () => {
  describe('baseUrl 包含 /anthropic → Anthropic 格式', () => {
    it('DeepSeek /anthropic', () => {
      expect(detectUseAnthropic('https://api.deepseek.com/anthropic')).toBe(true)
    })

    it('MiniMax /anthropic', () => {
      expect(detectUseAnthropic('https://maas-coding-api.cn-huabei-1.xf-yun.com/anthropic')).toBe(true)
    })

    it('Zhipu GLM /anthropic', () => {
      expect(detectUseAnthropic('https://open.bigmodel.cn/api/anthropic')).toBe(true)
    })

    it('claude-current /anthropic', () => {
      expect(detectUseAnthropic('https://token-plan-cn.xiaomimimo.com/anthropic')).toBe(true)
    })

    it('/anthropic 后跟 /v1', () => {
      expect(detectUseAnthropic('https://api.deepseek.com/anthropic/v1')).toBe(true)
    })

    it('/anthropic 在路径中间', () => {
      expect(detectUseAnthropic('https://api.example.com/anthropic/messages')).toBe(true)
    })
  })

  describe('baseUrl 不含 /anthropic → OpenAI 格式', () => {
    it('DouBaoSeed', () => {
      expect(detectUseAnthropic('https://ark.cn-beijing.volces.com/api/coding')).toBe(false)
    })

    it('OpenAI 官方', () => {
      expect(detectUseAnthropic('https://api.openai.com/v1')).toBe(false)
    })

    it('自定义 OpenAI 兼容', () => {
      expect(detectUseAnthropic('https://api.example.com/v1')).toBe(false)
    })

    it('无路径 baseUrl', () => {
      expect(detectUseAnthropic('https://api.example.com')).toBe(false)
    })

    it('anthropic 作为域名一部分（非路径）', () => {
      expect(detectUseAnthropic('https://anthropic-api.example.com/v1')).toBe(false)
    })
  })

  describe('无 baseUrl 时按 model 判断', () => {
    it('claude model → Anthropic', () => {
      expect(detectUseAnthropic(undefined, 'claude-sonnet-4-20250514')).toBe(true)
    })

    it('deepseek model → Anthropic', () => {
      expect(detectUseAnthropic(undefined, 'deepseek-v4-pro')).toBe(true)
    })

    it('gpt model → OpenAI', () => {
      expect(detectUseAnthropic(undefined, 'gpt-4o')).toBe(false)
    })

    it('o1 model → OpenAI', () => {
      expect(detectUseAnthropic(undefined, 'o1-preview')).toBe(false)
    })

    it('o3 model → OpenAI', () => {
      expect(detectUseAnthropic(undefined, 'o3-mini')).toBe(false)
    })

    it('无 model → Anthropic (默认)', () => {
      expect(detectUseAnthropic(undefined, undefined)).toBe(true)
    })

    it('空 model → Anthropic (默认)', () => {
      expect(detectUseAnthropic(undefined, '')).toBe(true)
    })
  })
})

import { describe, expect, it } from 'vitest'
import {
  COMPLETION_GUIDE_KEY,
  EXAMPLE_PROMPTS,
  GROUP_FLOW_GUIDE_KEY,
  ONBOARDING_CHECKLIST,
} from '../src/lib/onboarding'

describe('onboarding copy', () => {
  it('provides three example prompts and three setup steps', () => {
    expect(EXAMPLE_PROMPTS).toHaveLength(3)
    expect(ONBOARDING_CHECKLIST).toHaveLength(3)
    expect(ONBOARDING_CHECKLIST.map(item => item.title)).toEqual([
      '配置 CLI 或模型',
      '创建第一个群聊',
      '说出第一个需求',
    ])
  })

  it('keeps storage keys namespaced and stable', () => {
    expect(GROUP_FLOW_GUIDE_KEY).toBe('agenthub:group-flow-guide-seen')
    expect(COMPLETION_GUIDE_KEY).toBe('agenthub:completion-guide-seen')
  })
})

import { describe, it, expect } from 'vitest'
import {
  SCENE_ANALYSIS_PROMPT,
  ORCHESTRATOR_DECISION_PROMPT,
  ROLE_GENERATION_PROMPT,
  PM_CONFIRMATION_PROMPT,
  TASK_DECOMPOSITION_PROMPT,
  buildAgentQuestionPrompt,
  buildMonitoringPrompt,
  buildDiscussionPrompt,
} from '../src/lib/orchestrator/prompts'

describe('Prompt constants — structure validation', () => {
  it('SCENE_ANALYSIS_PROMPT should request JSON with type, complexity, description', () => {
    expect(SCENE_ANALYSIS_PROMPT).toContain('"type"')
    expect(SCENE_ANALYSIS_PROMPT).toContain('"complexity"')
    expect(SCENE_ANALYSIS_PROMPT).toContain('"description"')
    // Should specify allowed values
    expect(SCENE_ANALYSIS_PROMPT).toContain('"code"')
    expect(SCENE_ANALYSIS_PROMPT).toContain('"simple"')
    expect(SCENE_ANALYSIS_PROMPT).toContain('"complex"')
  })

  it('ORCHESTRATOR_DECISION_PROMPT should define all 8 action types', () => {
    const actions = ['self', 'delegate', 'discuss', 'align_confirm', 'align_decompose', 'align_qa', 'execute', 'done']
    for (const action of actions) {
      expect(ORCHESTRATOR_DECISION_PROMPT, `should define action: ${action}`).toContain(`"${action}"`)
    }
  })

  it('ORCHESTRATOR_DECISION_PROMPT should have {agentList} placeholder', () => {
    expect(ORCHESTRATOR_DECISION_PROMPT).toContain('{agentList}')
  })

  it('ORCHESTRATOR_DECISION_PROMPT should include few-shot examples', () => {
    expect(ORCHESTRATOR_DECISION_PROMPT).toContain('示例')
    expect(ORCHESTRATOR_DECISION_PROMPT).toContain('align_confirm')
    expect(ORCHESTRATOR_DECISION_PROMPT).toContain('align_decompose')
  })

  it('ROLE_GENERATION_PROMPT should request agent array with name/expertise/systemPrompt/platform', () => {
    expect(ROLE_GENERATION_PROMPT).toContain('"name"')
    expect(ROLE_GENERATION_PROMPT).toContain('"expertise"')
    expect(ROLE_GENERATION_PROMPT).toContain('"systemPrompt"')
    expect(ROLE_GENERATION_PROMPT).toContain('"platform"')
  })

  it('PM_CONFIRMATION_PROMPT should have {userMessage} placeholder', () => {
    expect(PM_CONFIRMATION_PROMPT).toContain('{userMessage}')
    expect(PM_CONFIRMATION_PROMPT).toContain('产品经理')
  })

  it('TASK_DECOMPOSITION_PROMPT should request task fields including declared_files', () => {
    expect(TASK_DECOMPOSITION_PROMPT).toContain('"id"')
    expect(TASK_DECOMPOSITION_PROMPT).toContain('"description"')
    expect(TASK_DECOMPOSITION_PROMPT).toContain('"assignedAgent"')
    expect(TASK_DECOMPOSITION_PROMPT).toContain('"dependencies"')
    expect(TASK_DECOMPOSITION_PROMPT).toContain('"declared_files"')
  })
})

describe('buildAgentQuestionPrompt', () => {
  it('should interpolate all parameters into the prompt', () => {
    const prompt = buildAgentQuestionPrompt('前端工程师', 'React开发', '用户需要一个登录页面', '使用Next.js实现')
    expect(prompt).toContain('前端工程师')
    expect(prompt).toContain('React开发')
    expect(prompt).toContain('用户需要一个登录页面')
    expect(prompt).toContain('使用Next.js实现')
  })

  it('should format as agent role prompt with architect plan section', () => {
    const prompt = buildAgentQuestionPrompt('后端工程师', 'Node.js', '搭建API', 'Express方案')
    expect(prompt).toContain('你是后端工程师')
    expect(prompt).toContain('专长：Node.js')
    expect(prompt).toContain('用户需求：搭建API')
    expect(prompt).toContain('架构师方案：')
    expect(prompt).toContain('Express方案')
  })

  it('should include instruction to reply "无问题" if no questions', () => {
    const prompt = buildAgentQuestionPrompt('测试', 'QA', '需求', '方案')
    expect(prompt).toContain('无问题')
  })

  it('should handle empty strings gracefully', () => {
    const prompt = buildAgentQuestionPrompt('', '', '', '')
    expect(prompt).toContain('你是')
    expect(prompt).toContain('专长：')
    expect(prompt).toContain('用户需求：')
  })
})

describe('buildMonitoringPrompt', () => {
  it('should include task description and truncated result in batch mode', () => {
    const prompt = buildMonitoringPrompt('实现登录功能', '代码已生成...', ['src/auth.ts'], {
      declared: ['src/auth.ts'],
      undeclared: ['src/unexpected.ts'],
    })
    expect(prompt).toContain('实现登录功能')
    expect(prompt).toContain('src/auth.ts')
    expect(prompt).toContain('src/unexpected.ts')
    expect(prompt).toContain('越界修改')
  })

  it('should show file audit info in batch mode', () => {
    const prompt = buildMonitoringPrompt('task', 'result', ['a.ts', 'b.ts'], {
      declared: ['a.ts'],
      undeclared: ['c.ts'],
    }, 'batch')
    expect(prompt).toContain('声明修改的文件：a.ts, b.ts')
    expect(prompt).toContain('实际修改的声明文件：a.ts')
    expect(prompt).toContain('越界修改的文件：c.ts')
  })

  it('should omit file audit info in single mode', () => {
    const prompt = buildMonitoringPrompt('task', 'result', ['a.ts'], {
      declared: [],
      undeclared: [],
    }, 'single')
    expect(prompt).not.toContain('声明修改的文件')
    expect(prompt).not.toContain('越界修改')
  })

  it('should show "无" for empty file lists', () => {
    const prompt = buildMonitoringPrompt('简单任务', '完成', [], {
      declared: [],
      undeclared: [],
    })
    expect(prompt).toContain('声明修改的文件：无')
    expect(prompt).toContain('实际修改的声明文件：无')
    expect(prompt).toContain('越界修改的文件：无')
  })

  it('should truncate task result to 500 characters', () => {
    const longResult = 'x'.repeat(1000)
    const prompt = buildMonitoringPrompt('task', longResult, [], { declared: [], undeclared: [] })
    expect(prompt).toContain('x'.repeat(500))
    expect(prompt).not.toContain('x'.repeat(501))
  })

  it('should request JSON output format', () => {
    const prompt = buildMonitoringPrompt('task', 'result', [], { declared: [], undeclared: [] })
    expect(prompt).toContain('"completed"')
    expect(prompt).toContain('"quality"')
    expect(prompt).toContain('"needsCorrection"')
  })
})

describe('buildDiscussionPrompt', () => {
  it('should include round info and agent name', () => {
    const prompt = buildDiscussionPrompt(2, 5, '之前的发言内容...', '设计师')
    expect(prompt).toContain('第 2/5 轮')
    expect(prompt).toContain('设计师')
    expect(prompt).toContain('之前的发言内容')
  })

  it('should indicate first speaker when no previous opinions', () => {
    const prompt = buildDiscussionPrompt(1, 3, '', '架构师')
    expect(prompt).toContain('第一个发言')
    expect(prompt).toContain('架构师')
  })

  it('should include previous opinions when provided', () => {
    const prompt = buildDiscussionPrompt(3, 5, 'Agent A: 我认为...\nAgent B: 同意...', '测试工程师')
    expect(prompt).toContain('Agent A: 我认为...')
    expect(prompt).toContain('Agent B: 同意...')
    expect(prompt).not.toContain('第一个发言')
  })

  it('should handle last round', () => {
    const prompt = buildDiscussionPrompt(5, 5, '前面的讨论...', 'PM')
    expect(prompt).toContain('第 5/5 轮')
  })
})

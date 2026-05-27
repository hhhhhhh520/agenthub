import { describe, it, expect } from 'vitest'

describe('Prompts Module', () => {
  it('should export SCENE_ANALYSIS_PROMPT', async () => {
    const { SCENE_ANALYSIS_PROMPT } = await import('../src/lib/orchestrator/prompts')
    expect(SCENE_ANALYSIS_PROMPT).toContain('任务分析器')
    expect(SCENE_ANALYSIS_PROMPT).toContain('type')
    expect(SCENE_ANALYSIS_PROMPT).toContain('complexity')
  })

  it('should export ORCHESTRATOR_DECISION_PROMPT', async () => {
    const { ORCHESTRATOR_DECISION_PROMPT } = await import('../src/lib/orchestrator/prompts')
    expect(ORCHESTRATOR_DECISION_PROMPT).toContain('Orchestrator')
    expect(ORCHESTRATOR_DECISION_PROMPT).toContain('agentList')
    expect(ORCHESTRATOR_DECISION_PROMPT).toContain('action')
  })

  it('should define all action types in ORCHESTRATOR_DECISION_PROMPT', async () => {
    const { ORCHESTRATOR_DECISION_PROMPT } = await import('../src/lib/orchestrator/prompts')
    expect(ORCHESTRATOR_DECISION_PROMPT).toContain('"self"')
    expect(ORCHESTRATOR_DECISION_PROMPT).toContain('"delegate"')
    expect(ORCHESTRATOR_DECISION_PROMPT).toContain('"discuss"')
    expect(ORCHESTRATOR_DECISION_PROMPT).toContain('"done"')
    expect(ORCHESTRATOR_DECISION_PROMPT).toContain('"align_confirm"')
    expect(ORCHESTRATOR_DECISION_PROMPT).toContain('"align_decompose"')
    expect(ORCHESTRATOR_DECISION_PROMPT).toContain('"align_qa"')
    expect(ORCHESTRATOR_DECISION_PROMPT).toContain('"execute"')
  })

  it('should contain few-shot examples in ORCHESTRATOR_DECISION_PROMPT', async () => {
    const { ORCHESTRATOR_DECISION_PROMPT } = await import('../src/lib/orchestrator/prompts')
    expect(ORCHESTRATOR_DECISION_PROMPT).toContain('align_confirm')
    expect(ORCHESTRATOR_DECISION_PROMPT).toContain('align_decompose')
    expect(ORCHESTRATOR_DECISION_PROMPT).toContain('示例')
  })

  it('should export ROLE_GENERATION_PROMPT', async () => {
    const { ROLE_GENERATION_PROMPT } = await import('../src/lib/orchestrator/prompts')
    expect(ROLE_GENERATION_PROMPT).toContain('团队组建专家')
    expect(ROLE_GENERATION_PROMPT).toContain('agents')
    expect(ROLE_GENERATION_PROMPT).toContain('platform')
  })

  it('should export PM_CONFIRMATION_PROMPT', async () => {
    const { PM_CONFIRMATION_PROMPT } = await import('../src/lib/orchestrator/prompts')
    expect(PM_CONFIRMATION_PROMPT).toContain('产品经理')
    expect(PM_CONFIRMATION_PROMPT).toContain('userMessage')
  })

  it('should export TASK_DECOMPOSITION_PROMPT', async () => {
    const { TASK_DECOMPOSITION_PROMPT } = await import('../src/lib/orchestrator/prompts')
    expect(TASK_DECOMPOSITION_PROMPT).toContain('架构师')
    expect(TASK_DECOMPOSITION_PROMPT).toContain('techStack')
    expect(TASK_DECOMPOSITION_PROMPT).toContain('tasks')
    expect(TASK_DECOMPOSITION_PROMPT).toContain('declared_files')
  })

  it('should specify task fields in TASK_DECOMPOSITION_PROMPT', async () => {
    const { TASK_DECOMPOSITION_PROMPT } = await import('../src/lib/orchestrator/prompts')
    expect(TASK_DECOMPOSITION_PROMPT).toContain('id')
    expect(TASK_DECOMPOSITION_PROMPT).toContain('description')
    expect(TASK_DECOMPOSITION_PROMPT).toContain('assignedAgent')
    expect(TASK_DECOMPOSITION_PROMPT).toContain('dependencies')
  })
})

describe('Prompt Builder Functions', () => {
  it('should export buildAgentQuestionPrompt', async () => {
    const { buildAgentQuestionPrompt } = await import('../src/lib/orchestrator/prompts')
    expect(typeof buildAgentQuestionPrompt).toBe('function')
  })

  it('should build agent question prompt with all parameters', async () => {
    const { buildAgentQuestionPrompt } = await import('../src/lib/orchestrator/prompts')
    const prompt = buildAgentQuestionPrompt(
      '前端工程师',
      'React开发',
      '用户需要一个登录页面',
      '使用Next.js实现'
    )
    expect(prompt).toContain('前端工程师')
    expect(prompt).toContain('React开发')
    expect(prompt).toContain('登录页面')
    expect(prompt).toContain('Next.js')
  })

  it('should export buildMonitoringPrompt', async () => {
    const { buildMonitoringPrompt } = await import('../src/lib/orchestrator/prompts')
    expect(typeof buildMonitoringPrompt).toBe('function')
  })

  it('should build monitoring prompt with audit result', async () => {
    const { buildMonitoringPrompt } = await import('../src/lib/orchestrator/prompts')
    const prompt = buildMonitoringPrompt(
      '实现登录功能',
      '代码已生成...',
      ['src/auth.ts', 'src/login.tsx'],
      { declared: ['src/auth.ts'], undeclared: ['src/unexpected.ts'] }
    )
    expect(prompt).toContain('实现登录功能')
    expect(prompt).toContain('src/auth.ts')
    expect(prompt).toContain('src/unexpected.ts')
    expect(prompt).toContain('越界修改')
  })

  it('should handle empty declared files', async () => {
    const { buildMonitoringPrompt } = await import('../src/lib/orchestrator/prompts')
    const prompt = buildMonitoringPrompt(
      '简单任务',
      '完成',
      [],
      { declared: [], undeclared: [] }
    )
    expect(prompt).toContain('声明修改的文件：无')
    expect(prompt).toContain('实际修改的声明文件：无')
    expect(prompt).toContain('越界修改的文件：无')
  })

  it('should export buildDiscussionPrompt', async () => {
    const { buildDiscussionPrompt } = await import('../src/lib/orchestrator/prompts')
    expect(typeof buildDiscussionPrompt).toBe('function')
  })

  it('should build discussion prompt with round info', async () => {
    const { buildDiscussionPrompt } = await import('../src/lib/orchestrator/prompts')
    const prompt = buildDiscussionPrompt(2, 5, '之前的发言内容...', '设计师')
    expect(prompt).toContain('第 2/5 轮')
    expect(prompt).toContain('设计师')
    expect(prompt).toContain('之前的发言内容')
  })

  it('should handle first round (no previous opinions)', async () => {
    const { buildDiscussionPrompt } = await import('../src/lib/orchestrator/prompts')
    const prompt = buildDiscussionPrompt(1, 3, '', '架构师')
    expect(prompt).toContain('第一个发言')
    expect(prompt).toContain('架构师')
  })

  it('should include task result in monitoring prompt', async () => {
    const { buildMonitoringPrompt } = await import('../src/lib/orchestrator/prompts')
    const longResult = 'x'.repeat(1000)
    const prompt = buildMonitoringPrompt('task', longResult, [], { declared: [], undeclared: [] })
    // The prompt should contain the task result (truncated to 500 chars in the function)
    expect(prompt).toContain('任务产出')
    // Verify the result is included (at least first 500 chars)
    expect(prompt).toContain('x'.repeat(100))
  })
})
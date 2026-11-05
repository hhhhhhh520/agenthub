export const EXAMPLE_PROMPTS = [
  '做一个 TODO 应用，支持增删改查和分类',
  '为现有项目补一套单元测试，并修复失败用例',
  '分析当前仓库架构，给出重构计划',
] as const

export const ONBOARDING_CHECKLIST = [
  {
    title: '配置 CLI 或模型',
    detail: 'Setup Wizard 已完成；之后可在设置里切换平台和模型。',
  },
  {
    title: '创建第一个群聊',
    detail: '描述需求并选择项目目录；目录可先留空，使用应用默认工作目录。',
  },
  {
    title: '说出第一个需求',
    detail: 'Orchestrator 会先对齐需求，再交给架构师拆解任务。',
  },
] as const

export const GROUP_FLOW_GUIDE_KEY = 'agenthub:group-flow-guide-seen'
export const COMPLETION_GUIDE_KEY = 'agenthub:completion-guide-seen'

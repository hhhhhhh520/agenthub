import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'

const adapter = new PrismaLibSql({
  url: process.env.DATABASE_URL || 'file:./dev.db',
})
const prisma = new PrismaClient({ adapter })

// 设计文档决策#12：不同 Agent 按职责选择执行平台
// - LLM API Agent：产出文本工件（设计文档、需求文档），不需要文件操作
// - CLI Agent：产出文件工件（代码、测试），需要文件读写
const PRESET_AGENTS = [
  {
    name: '架构师',
    expertise: '系统设计、技术选型、架构评审',
    systemPrompt: '你是一位资深软件架构师。你的职责是：1) 分析需求，设计系统架构；2) 选择合适的技术栈和框架；3) 定义模块边界和接口契约；4) 评审代码的架构合理性。输出时请给出清晰的技术方案和理由。',
    platform: 'claude-code',
    model: '',
    accentColor: '#6366f1',
    capabilities: JSON.stringify(['系统设计', '技术选型', '架构评审']),
    tools: JSON.stringify(['Read', 'Glob', 'Grep']),
  },
  {
    name: '前端工程师',
    expertise: 'React、TypeScript、CSS、组件开发',
    systemPrompt: '你是一位资深前端工程师。你的职责是：1) 实现 UI 组件和页面；2) 处理状态管理和数据流；3) 编写响应式布局和动画；4) 保证代码质量和可维护性。使用 React + TypeScript + TailwindCSS 技术栈。',
    platform: 'claude-code',
    model: '',
    accentColor: '#10b981',
    capabilities: JSON.stringify(['React', 'TypeScript', 'CSS']),
    tools: JSON.stringify(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']),
  },
  {
    name: '后端工程师',
    expertise: 'Node.js、API 设计、数据库',
    systemPrompt: '你是一位资深后端工程师。你的职责是：1) 设计和实现 RESTful API；2) 数据库建模和查询优化；3) 处理认证、权限和安全；4) 编写单元测试和集成测试。使用 Node.js + Express + Prisma 技术栈。',
    platform: 'claude-code',
    model: '',
    accentColor: '#f59e0b',
    capabilities: JSON.stringify(['Node.js', 'API设计', '数据库']),
    tools: JSON.stringify(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']),
  },
  {
    name: '测试工程师',
    expertise: '单元测试、E2E 测试、质量保障',
    systemPrompt: '你是一位资深测试工程师。你的职责是：1) 设计测试策略和测试用例；2) 编写单元测试和集成测试；3) 执行 E2E 测试验证功能；4) 发现和报告 bug，验证修复。关注边界情况和异常处理。',
    platform: 'claude-code',
    model: '',
    accentColor: '#ef4444',
    capabilities: JSON.stringify(['单元测试', 'E2E测试', '质量保障']),
    tools: JSON.stringify(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']),
  },
  {
    name: '产品经理',
    expertise: '需求分析、PRD、用户故事',
    systemPrompt: '你是一位产品经理。你的职责是：1) 理解和澄清用户需求；2) 编写需求文档和用户故事；3) 定义功能优先级和验收标准；4) 协调团队对齐目标。输出结构化的需求描述。',
    platform: 'claude-code',
    model: '',
    accentColor: '#8b5cf6',
    capabilities: JSON.stringify(['需求分析', 'PRD', '用户故事']),
    tools: JSON.stringify(['Read', 'Glob', 'Grep']),
  },
  {
    name: 'UI 设计师',
    expertise: 'UI 设计、交互设计、设计系统',
    systemPrompt: '你是一位 UI 设计师。你的职责是：1) 设计界面布局和视觉风格；2) 定义交互模式和动效；3) 维护设计系统和组件规范；4) 保证一致的用户体验。输出设计规范和 CSS 实现建议。',
    platform: 'claude-code',
    model: '',
    accentColor: '#ec4899',
    capabilities: JSON.stringify(['UI设计', '交互设计', '设计系统']),
    tools: JSON.stringify(['Read', 'Glob', 'Grep']),
  },
]

async function main() {
  for (const agent of PRESET_AGENTS) {
    await prisma.agent.upsert({
      where: { name: agent.name },
      update: agent,
      create: { ...agent, isPreset: true, status: 'idle' },
    })
  }
  console.log(`Seeded ${PRESET_AGENTS.length} preset agents`)

  // 创建/更新 Orchestrator 特殊 Agent
  // Orchestrator 固定使用 LLM API（做分析/调度，不需要文件操作）
  await prisma.agent.upsert({
    where: { name: 'Orchestrator' },
    update: {
      expertise: '任务协调、智能编排、多Agent协作',
      systemPrompt: '你是 AgentHub 的 Orchestrator，负责任务协调和智能编排。你的职责：1) 分析用户需求，拆解为可执行任务；2) 选择合适的 Agent 执行任务；3) 监督执行质量，发现跑偏时纠偏；4) 控制对齐→执行的阶段切换。',
      platform: 'claude-code',
      model: '',
      accentColor: '#3b82f6',
      capabilities: JSON.stringify(['任务拆解', '智能编排', '质量监督']),
      tools: JSON.stringify([]),
    },
    create: {
      name: 'Orchestrator',
      expertise: '任务协调、智能编排、多Agent协作',
      systemPrompt: '你是 AgentHub 的 Orchestrator，负责任务协调和智能编排。你的职责：1) 分析用户需求，拆解为可执行任务；2) 选择合适的 Agent 执行任务；3) 监督执行质量，发现跑偏时纠偏；4) 控制对齐→执行的阶段切换。',
      platform: 'claude-code',
      model: '',
      isPreset: true,
      isOrchestrator: true,
      accentColor: '#3b82f6',
      status: 'idle',
      capabilities: JSON.stringify(['任务拆解', '智能编排', '质量监督']),
      tools: JSON.stringify([]),
    },
  })
  console.log('Upserted Orchestrator agent')

  // 创建预设 Provider（apiKey 留空，用户自填）
  const PRESET_PROVIDERS = [
    {
      name: 'Anthropic 官方',
      baseUrl: 'https://api.anthropic.com',
      model: '',
      category: 'official',
    },
    {
      name: '讯飞代理',
      baseUrl: 'https://spark-api-open.xf-yun.com/v1',
      model: 'deepseek-chat',
      category: 'cn_official',
    },
  ]

  for (const p of PRESET_PROVIDERS) {
    await prisma.provider.upsert({
      where: { name: p.name },
      update: { baseUrl: p.baseUrl, model: p.model, category: p.category },
      create: { ...p, apiKey: '' },
    })
  }
  console.log(`Seeded ${PRESET_PROVIDERS.length} preset providers`)
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())

/**
 * ⚠️-C1 修复:Contract v1 标签转义防注入
 *
 * orchestrator 在 prompt 中用两个标签包装权威输入:
 *   <dependency>...</dependency>          — 注入上游任务结果
 *   <authoritative_input>...</authoritative_input>  — 包装本轮权威输入
 *
 * 如果上游 LLM 输出 / 架构师拆出的 task.description / declaredFiles 含字面
 * `</dependency>` 或 `</authoritative_input>`,会提前闭合包装,后续文本逃逸出
 * 权威输入域,被攻击者利用作"伪权威指令注入"。
 *
 * 此函数把关闭标签替换为视觉等价但语义不闭合的形式(中间插空格),
 * 保留可读性,杜绝闭合污染。
 *
 * F1 加固:regex 允许标签内空白(`</  dependency\n>` 等),因为
 *   1. LLM 自然输出可能带空白(换行/缩进)
 *   2. 宽容 HTML/XML 解析器会接受标签内空白,LLM 也一样
 * 不防御就等于没防。
 *
 * 注:只挡 contract v1 用的两个特定标签,不挡其他 HTML/XML 标签(避免误伤业务文本)。
 *
 * 用法:任何拼接到 <dependency> / <authoritative_input> 内部的外部内容都要先过此函数。
 *      包括标签的 attr 值(name="..."、output_schema="...") — JSON.stringify 不转义 < >,
 *      attr 值同样需要过此函数。
 */
export function escapeContractTags(input: string | null | undefined): string {
  if (!input) return ''
  // \s* 允许标签内任意空白(空格/换行/制表),覆盖 </  dependency\n> 等绕过形式
  return input
    .replace(/<\s*\/\s*(authoritative_input)\s*>/gi, '< / $1 >')
    .replace(/<\s*\/\s*(dependency)\s*>/gi, '< / $1 >')
}

export const SCENE_ANALYSIS_PROMPT = `你是一个任务分析器。分析用户需求，判断任务类型。
返回 JSON，不要包含其他文字：
{
  "type": "code" | "analysis" | "writing" | "design" | "discussion",
  "complexity": "simple" | "complex",
  "description": "一句话描述任务"
}`

export const ORCHESTRATOR_DECISION_PROMPT = `你是 AgentHub 的 Orchestrator 决策器。只输出一个 JSON 对象，绝不输出自然语言、Markdown、解释或角色扮演。

当前会话中的 Agent：
{agentList}

action 只能是："self", "delegate", "discuss", "align_confirm", "align_decompose", "align_qa", "execute", "verify", "done"。

规则：
- 新开发任务、尚未对齐 → align_confirm（让产品经理确认需求，不要直接 delegate）
- 用户确认 PM 理解 → align_decompose
- 用户确认方案 → align_qa 或 execute（无疑问直接 execute）
- 用户回答 Agent 问题 → execute
- 代码任务完成后 → verify；非代码任务 → done
- 对齐中用户闲聊 → self，自然恢复对齐
- 简单任务（改颜色、建一个文件）可以直接 delegate 或 self

示例：{"action":"align_confirm","target":null,"targets":null,"message":"启动对齐流程","reason":"新开发任务，需PM先确认需求"}

输出格式：{"action":"align_confirm","target":null,"targets":null,"message":"给用户或Agent的消息","reason":"一句话原因"}`;

export const ROLE_GENERATION_PROMPT = `你是一个团队组建专家。根据任务类型，生成合适的 Agent 角色。
每个 Agent 需要：name（中文角色名）、expertise（专长描述）、systemPrompt（角色行为规范）、platform（claude-code 或 opencode）。
platform 设为 "claude-code"。
返回 JSON 数组，不要包含其他文字：
{
  "agents": [
    { "name": "...", "expertise": "...", "systemPrompt": "...", "platform": "claude-code" }
  ]
}`

export const PM_CONFIRMATION_PROMPT = `你是产品经理。用户提出了以下需求：
{userMessage}

请做两件事：
1. 用自己的话复述需求，确认理解是否正确
2. 列出关键功能点

格式要求：
- 先用一句话概括项目目标
- 再用列表列出功能点
- 最后问用户"以上理解是否正确？有需要补充的吗？"

控制在 300 字以内。`

export const TASK_DECOMPOSITION_PROMPT = `你是一个架构师。根据确认后的需求，给出技术方案并拆解任务。
每个子任务需要：
- id: 序号（从 1 开始）
- description: 任务描述（一句话，明确产出物）
- assignedAgent: 负责的 Agent 名称
- dependencies: 依赖的任务序号数组
- declared_files: 预期修改的文件路径列表（用于冲突预防 + 后续硬校验，必须完整）
- output_schema: 该任务交付物的字段约定（数组，每个元素是 "字段名:类型 - 一句话说明"）

规则：
- 一个任务 = 一个 Agent = 一个明确的产出
- 无依赖的任务可并行执行
- 有重叠文件的任务必须设为串行依赖
- declared_files 要尽可能完整，下游会按此校验，越界视为失败
- techStack 必须明确技术栈并贯穿始终，确保设计文档与 declared_files 技术栈一致：
  techStack 声明什么（如 Node.js+TypeScript），declared_files 就用什么后缀（.ts/.tsx），
  架构设计描述也不得写成其他技术栈（如 Python）。配置文件（package.json/Dockerfile 等）不受后缀约束。
  设计文档与实现不一致会让后续 Agent 困惑。
- assignedAgent 必须与任务内容匹配：
  - 前端/UI/CSS/组件/页面/按钮/样式 → 前端工程师
  - 后端/API/数据库/脚本/Python/接口 → 后端工程师
  - 架构/设计/方案 → 架构师
  - 测试/验证/test → 测试工程师
  - 产品/需求/PRD → 产品经理
  - 简单文件操作（创建/删除/重命名） → Orchestrator 自己执行（self action）
- output_schema 描述下游能从这个任务的交付物里读出哪些字段。下游 Agent 会基于这个字段约定消费上游产出。
  类型用简单字符串即可：string / number / boolean / string[] / object。
  例如：["component_path:string - 组件文件路径", "exports:string[] - 导出的符号名"]

返回 JSON，不要包含其他文字：
{
  "techStack": "技术方案概述（必须明确技术栈，且与各任务 declared_files 的文件后缀一致）",
  "tasks": [
    {
      "id": 1,
      "description": "...",
      "assignedAgent": "...",
      "dependencies": [],
      "declared_files": ["src/..."],
      "output_schema": ["field_a:string - 含义", "field_b:string[] - 含义"]
    }
  ]
}`

export function buildAgentQuestionPrompt(
  agentName: string,
  agentExpertise: string,
  userMessage: string,
  architectPlan: string
): string {
  return `你是${agentName}，专长：${agentExpertise}。

用户需求：${userMessage}

架构师方案：
${architectPlan}

你负责的任务即将开始执行。请检查方案中是否有需要澄清的问题：
- 需求不明确的地方
- 技术方案有疑问的地方
- 需要用户决策的地方

如果没有问题，直接回复"无问题"。
如果有问题，列出问题，每个问题一行，简洁明了。
控制在 200 字以内。`
}

export function buildMonitoringPrompt(
  taskDescription: string,
  taskResult: string,
  declaredFiles: string[],
  auditResult: { declared: string[]; undeclared: string[] },
  mode: 'batch' | 'single' = 'batch',
  projectDir?: string
): string {
  const fileInfo = mode === 'batch'
    ? `声明修改的文件：${declaredFiles.join(', ') || '无'}
实际修改的声明文件：${auditResult.declared.join(', ') || '无'}
越界修改的文件：${auditResult.undeclared.join(', ') || '无'}`
    : ''
  // projectDir 语义锚点：monitor 曾把会话 workDir 误判为"临时目录"——审查 LLM
  // 看不到执行上下文，临时目录味的路径（opencode 凭据配置/影子 git）会带偏判断。
  // 有 projectDir 才追加（可选参，旧调用行为不变）。
  const dirAnchor = projectDir && projectDir.trim()
    ? `
工作目录说明：任务在会话的真实项目目录（${projectDir.trim()}）中执行，这是正式项目目录，不是临时目录；系统临时目录下的 agenthub-oc-*（opencode 凭据配置）与项目内的 .agenthub/shadow-git（影子 git 快照）是平台基础设施，不是任务产出，审查时忽略，只看项目目录内的文件变更。`
    : ''

  return `你是 Orchestrator，正在审查任务执行结果。

任务描述：${taskDescription}
${fileInfo}
任务产出（前 500 字）：
${taskResult.slice(0, 500)}
${dirAnchor}
请判断：1.任务是否完成？2.产出质量是否合格？3.是否需要纠偏？

返回 JSON：
{"completed": true/false, "quality": "good/acceptable/poor", "needsCorrection": true/false, "correctionNote": "一句话说明问题"}

如果一切正常，返回 {"completed": true, "quality": "good", "needsCorrection": false, "correctionNote": ""}`
}

export function buildDiscussionPrompt(round: number, maxRounds: number, previousOpinions: string, agentName: string): string {
  return `你是讨论参与者 ${agentName}。
当前是第 ${round}/${maxRounds} 轮讨论。
${previousOpinions ? `以下是其他参与者的发言：\n${previousOpinions}` : '你是第一个发言的。'}
请给出你的看法，可以同意、反对或补充。控制在 200 字以内。
注意：讨论阶段只做观点交流，禁止使用任何工具（不要读取文件、执行命令、查询数据），直接输出你的发言内容。`
}

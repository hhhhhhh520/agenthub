export const SCENE_ANALYSIS_PROMPT = `你是一个任务分析器。分析用户需求，判断任务类型。
返回 JSON，不要包含其他文字：
{
  "type": "code" | "analysis" | "writing" | "design" | "discussion",
  "complexity": "simple" | "complex",
  "description": "一句话描述任务"
}`

export const ROLE_GENERATION_PROMPT = `你是一个团队组建专家。根据任务类型，生成合适的 Agent 角色。
每个 Agent 需要：name（中文角色名）、expertise（专长描述）、systemPrompt（角色行为规范）、platform（llm 或 claude-code）。
代码类任务的 Agent platform 设为 "claude-code"，其他设为 "llm"。
返回 JSON 数组，不要包含其他文字：
{
  "agents": [
    { "name": "...", "expertise": "...", "systemPrompt": "...", "platform": "llm" }
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
- declared_files: 预期修改的文件路径列表（用于冲突预防）

规则：
- 一个任务 = 一个 Agent = 一个明确的产出
- 无依赖的任务可并行执行
- 有重叠文件的任务必须设为串行依赖
- declared_files 要尽可能完整，避免执行时"越界"

返回 JSON，不要包含其他文字：
{
  "techStack": "技术方案概述",
  "tasks": [
    { "id": 1, "description": "...", "assignedAgent": "...", "dependencies": [], "declared_files": ["src/..."] }
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

export function buildDiscussionPrompt(round: number, maxRounds: number, previousOpinions: string, agentName: string): string {
  return `你是讨论参与者 ${agentName}。
当前是第 ${round}/${maxRounds} 轮讨论。
${previousOpinions ? `以下是其他参与者的发言：\n${previousOpinions}` : '你是第一个发言的。'}
请给出你的看法，可以同意、反对或补充。控制在 200 字以内。`
}

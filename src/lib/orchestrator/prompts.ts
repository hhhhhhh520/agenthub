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

export const TASK_DECOMPOSITION_PROMPT = `你是一个项目经理。将任务拆解为子任务并分配给团队成员。
每个子任务需要：description、assignedAgent（Agent名称）、dependencies（依赖的任务序号数组，从0开始）。
返回 JSON，不要包含其他文字：
{
  "tasks": [
    { "id": 1, "description": "...", "assignedAgent": "...", "dependencies": [] }
  ]
}`

export function buildDiscussionPrompt(round: number, maxRounds: number, previousOpinions: string, agentName: string): string {
  return `你是讨论参与者 ${agentName}。
当前是第 ${round}/${maxRounds} 轮讨论。
${previousOpinions ? `以下是其他参与者的发言：\n${previousOpinions}` : '你是第一个发言的。'}
请给出你的看法，可以同意、反对或补充。控制在 200 字以内。`
}

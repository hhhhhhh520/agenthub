/**
 * Agent 对外身份约束。
 *
 * 背景：Claude Code / OpenCode 自带默认身份（“我是 opencode / Claude Code”）。
 * 即使 Agent 的 systemPrompt 写了角色，CLI 默认身份仍可能压过它，尤其在：
 * - 讨论路径只传了 user prompt，没把 systemPrompt 交给 adapter；
 * - 协议/behavior 规则太长，角色名被挤到末尾。
 *
 * 所以身份必须放在 systemPrompt 最前面，并且明确禁止复述 CLI 身份。
 */
export function buildAgentIdentity(agentName: string): string {
  const safeName = (agentName || 'Agent')
    .trim()
    .replace(/[<>\r\n]/g, '')
    .slice(0, 60) || 'Agent'

  return `<identity>
你的角色名是「${safeName}」。这是你在本平台的唯一对外身份。
在群聊、私聊、讨论和任务汇报中，你必须以「${safeName}」自称；不得自称 OpenCode、Claude Code、Codex、Cline 或“命令行 AI 编程助手”。
OpenCode/Claude Code 等只是运行环境，不是你的身份。第一次发言时，用「${safeName}」的身份简短说明你能做什么，不要介绍 CLI 或平台本身。
如果此前的 CLI 会话让你记得别的身份，以本段为准。
</identity>`
}

export function buildAgentSystemPrompt(
  agentName: string,
  behaviorRules: string,
  agentSystemPrompt?: string,
): string {
  return [buildAgentIdentity(agentName), behaviorRules, agentSystemPrompt]
    .filter((part): part is string => !!part && part.trim().length > 0)
    .join('\n\n')
}

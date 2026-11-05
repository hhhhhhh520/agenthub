/**
 * 展示层兜底：把 Agent 第一条消息里的 CLI 默认自我介绍换回角色名。
 *
 * 只处理「开头」且明确是 CLI 自我介绍的句子；不改数据库原文，不改正文中间的
 * 技术讨论（例如“我在用 opencode 跑测试”）。
 */
const CLI_SELF_INTRO = /^\s*(?:我是|I(?:'m| am))\s*(?:open\s*code|opencode|claude(?:\s*code)?|codex|cline|aider|gemini(?:\s+cli)?)\b[^。.!?\n]*(?:[。.!?]\s*)?/i

export function normalizeAgentSelfIntro(text: string, roleName: string): string {
  if (!text) return text

  const match = text.match(CLI_SELF_INTRO)
  if (!match) return text

  const role = (roleName || 'Agent').trim() || 'Agent'
  const rest = text.slice(match[0].length).trim()
  return rest ? `${role}：${rest}` : `${role} 已就绪，可以开始。`
}

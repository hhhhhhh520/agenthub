import { execSync } from 'child_process'

export type CLIPlatform = 'claude-code' | 'opencode'

/**
 * 检测当前机器可用的 CLI 平台
 * 优先级：claude-code → opencode
 * 返回 null 表示没有可用的 CLI
 */
export function detectCLIPlatform(): CLIPlatform | null {
  try {
    execSync('claude --version', { timeout: 3000, stdio: 'pipe' })
    return 'claude-code'
  } catch {}

  try {
    execSync('opencode --version', { timeout: 3000, stdio: 'pipe' })
    return 'opencode'
  } catch {}

  return null
}

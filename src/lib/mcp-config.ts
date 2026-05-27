import { join } from 'path'

/**
 * 构造 Claude Code CLI 的 --mcp-config JSON 字符串
 * 每个 Agent 进程会启动自己的 MCP Server 实例，通过环境变量传入会话信息
 */
export function buildMCPConfig(sessionId: string, agentName: string, workDir: string): string {
  const isProd = process.env.NODE_ENV === 'production'
  const command = isProd ? 'node' : 'npx'
  const args = isProd
    ? [join(process.cwd(), 'src/mcp-server/index.js')]
    : ['tsx', join(process.cwd(), 'src/mcp-server/index.ts')]

  const config = {
    mcpServers: {
      agenthub: {
        command,
        args,
        env: {
          AGENTHUB_SESSION_ID: sessionId,
          AGENTHUB_AGENT_NAME: agentName,
          AGENTHUB_WORK_DIR: workDir,
        },
      },
    },
  }
  return JSON.stringify(config)
}

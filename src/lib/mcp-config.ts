import { isAbsolute, join, resolve } from 'path'

/**
 * MCP 子进程的 cwd 是工作区，不是 AgentHub 进程 cwd。主进程的
 * `file:./dev.db` 若原样传给子进程会被相对到工作区；这里以主进程 cwd
 * 统一解析成绝对 file URL，非 file URL（libsql/http）原样传递。
 */
function resolveDatabaseUrl(): string {
  const configured = process.env.DATABASE_URL?.trim()
  if (!configured) return `file:${resolve(process.cwd(), 'dev.db')}`
  if (!configured.startsWith('file:')) return configured

  const rest = configured.slice('file:'.length)
  const queryIndex = rest.indexOf('?')
  const pathPart = queryIndex >= 0 ? rest.slice(0, queryIndex) : rest
  const query = queryIndex >= 0 ? rest.slice(queryIndex) : ''
  if (!pathPart || isAbsolute(pathPart)) return configured

  return `file:${resolve(process.cwd(), pathPart)}${query}`
}

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

  const dbUrl = resolveDatabaseUrl()

  const config = {
    mcpServers: {
      agenthub: {
        command,
        args,
        env: {
          AGENTHUB_SESSION_ID: sessionId,
          AGENTHUB_AGENT_NAME: agentName,
          AGENTHUB_WORK_DIR: workDir,
          DATABASE_URL: dbUrl,
        },
      },
    },
  }
  return JSON.stringify(config)
}

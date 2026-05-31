import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { PrismaClient } from '../generated/prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { readFileSync, readdirSync, statSync, realpathSync } from 'fs'
import { join, resolve, sep } from 'path'
import { z } from 'zod'

// 独立 Prisma 初始化（不依赖 Next.js）
const dbAdapter = new PrismaLibSql({
  url: process.env.DATABASE_URL || 'file:./dev.db',
})
const prisma = new PrismaClient({ adapter: dbAdapter })
prisma.$executeRawUnsafe('PRAGMA journal_mode=WAL').catch(() => {})
prisma.$executeRawUnsafe('PRAGMA foreign_keys=ON').catch(() => {})

const SESSION_ID = process.env.AGENTHUB_SESSION_ID || ''
const AGENT_NAME = process.env.AGENTHUB_AGENT_NAME || ''
const WORK_DIR = resolve(process.env.AGENTHUB_WORK_DIR || '.')
const REAL_WORK_DIR = realpathSync(WORK_DIR)

function isPathSafe(filePath: string): boolean {
  try {
    const realPath = realpathSync(filePath)
    return realPath === REAL_WORK_DIR || realPath.startsWith(REAL_WORK_DIR + sep)
  } catch {
    // realpathSync throws if file doesn't exist, but resolve+startsWith
    // can still be bypassed by .. paths — reject unknown paths
    const resolved = resolve(filePath)
    return resolved === WORK_DIR || resolved.startsWith(WORK_DIR + sep)
  }
}

const server = new McpServer({
  name: 'agenthub',
  version: '1.0.0',
})

// 工具 1: 读取项目目录中的文件
server.tool(
  'read_artifact',
  '读取项目中的文件内容。路径相对于项目根目录，各Agent子目录：frontend/(前端)、backend/(后端)、test/(测试)、architect/(架构)、product/(产品)。示例：frontend/src/App.tsx、backend/api.ts',
  { path: z.string().describe('相对于项目根目录的文件路径，如 frontend/src/App.tsx') },
  async ({ path: filePath }) => {
    const fullPath = resolve(WORK_DIR, filePath)
    if (!isPathSafe(fullPath)) {
      return { content: [{ type: 'text', text: '错误：路径超出项目目录' }] }
    }
    try {
      const content = readFileSync(fullPath, 'utf-8')
      return { content: [{ type: 'text', text: content }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `读取失败: ${err}` }] }
    }
  }
)

// 工具 2: 列出目录中的文件
server.tool(
  'list_files',
  '列出项目目录中的文件。可指定子目录如 frontend/、backend/ 查看特定Agent的产出',
  { dir: z.string().optional().describe('相对于项目根目录的目录路径，如 frontend/、backend/，默认列出根目录') },
  async ({ dir }) => {
    const targetDir = resolve(WORK_DIR, dir || '.')
    if (!targetDir.startsWith(WORK_DIR)) {
      return { content: [{ type: 'text', text: '错误：路径超出项目目录' }] }
    }
    try {
      const entries = readdirSync(targetDir, { recursive: true })
      const files = entries
        .filter(e => typeof e === 'string')
        .map(e => {
          const fp = join(targetDir, e as string)
          try {
            const s = statSync(fp)
            return `${s.isDirectory() ? '[D] ' : '[F] '}${e}`
          } catch {
            return `[?] ${e}`
          }
        })
      return { content: [{ type: 'text', text: files.join('\n') || '(空目录)' }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `列出失败: ${err}` }] }
    }
  }
)

// 工具 3: 查看所有任务状态
server.tool(
  'list_tasks',
  '查看当前会话中所有任务的状态和分配情况',
  {},
  async () => {
    if (!SESSION_ID) {
      return { content: [{ type: 'text', text: '错误：未设置 SESSION_ID' }] }
    }
    try {
      const tasks = await prisma.task.findMany({
        where: { sessionId: SESSION_ID },
        orderBy: { createdAt: 'asc' },
      })
      const lines = tasks.map(t => {
        const dep = t.dependencies !== '[]' ? ` (依赖: ${t.dependencies})` : ''
        return `[${t.status}] ${t.description} → ${t.assignedAgentId || '未分配'}${dep}`
      })
      return { content: [{ type: 'text', text: lines.join('\n') || '暂无任务' }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `查询失败: ${err}` }] }
    }
  }
)

// 工具 4: 发消息到共享频道
server.tool(
  'post_message',
  '向其他Agent发送消息（在协作频道中发言）',
  { content: z.string().describe('消息内容') },
  async ({ content }) => {
    if (!SESSION_ID || !AGENT_NAME) {
      return { content: [{ type: 'text', text: '错误：未设置 SESSION_ID 或 AGENT_NAME' }] }
    }
    try {
      await prisma.message.create({
        data: {
          role: 'agent',
          rawContent: content,
          sessionId: SESSION_ID,
          agentId: AGENT_NAME,
        },
      })
      return { content: [{ type: 'text', text: '消息已发送' }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `发送失败: ${err}` }] }
    }
  }
)

// 工具 5: 读取其他Agent的消息
server.tool(
  'read_messages',
  '读取其他Agent的消息（查看协作频道中的对话）',
  { since: z.string().optional().describe('只读取此时间之后的消息（ISO时间戳）') },
  async ({ since }) => {
    if (!SESSION_ID) {
      return { content: [{ type: 'text', text: '错误：未设置 SESSION_ID' }] }
    }
    try {
      const where: Record<string, unknown> = { sessionId: SESSION_ID, role: 'agent' }
      if (since) {
        where.createdAt = { gt: new Date(since) }
      }
      const messages = await prisma.message.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: 50,
      })
      const lines = messages.map(m =>
        `[${m.createdAt.toISOString()}] ${m.agentId}: ${m.rawContent.slice(0, 500)}`
      )
      return { content: [{ type: 'text', text: lines.join('\n') || '暂无消息' }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `读取失败: ${err}` }] }
    }
  }
)

// 启动
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
main().catch(err => {
  console.error('MCP Server 启动失败:', err)
  process.exit(1)
})

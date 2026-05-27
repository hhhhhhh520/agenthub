import { spawn, type ChildProcess } from 'child_process'
import { mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { AgentAdapter, AdapterConfig, AgentTask, StreamChunk } from './types'

// 默认工作目录：项目的 workspaces 目录（在 Claude Code 允许范围内）
const DEFAULT_WORK_DIR = join(process.cwd(), 'workspaces', 'default')

export class ClaudeCodeAdapter implements AgentAdapter {
  private workDir: string = ''
  private process: ChildProcess | null = null
  private sessionId: string | null = null
  private permissionMode: string = 'default'
  private mcpConfig: string | undefined

  async connect(config: AdapterConfig): Promise<void> {
    this.workDir = config.workDir || DEFAULT_WORK_DIR
    this.sessionId = config.sessionId || null
    this.permissionMode = config.permissionMode || 'default'
    this.mcpConfig = config.mcpConfig
    if (!existsSync(this.workDir)) {
      mkdirSync(this.workDir, { recursive: true })
    }
  }

  async *send(task: AgentTask): AsyncIterable<StreamChunk> {
    // Use stdin to pass prompt (avoids shell escaping issues with Chinese/special chars)
    const args = ['--output-format', 'stream-json', '--verbose', '--bare']

    // MCP 协作工具支持
    if (this.mcpConfig) {
      args.push('--mcp-config', this.mcpConfig)
    }

    // 添加权限模式
    if (this.permissionMode) {
      args.push('--permission-mode', this.permissionMode)
    }

    // 恢复已有会话
    if (this.sessionId) {
      args.push('--resume', this.sessionId)
    }

    const isWin = process.platform === 'win32'
    const cmd = isWin ? 'chcp 65001 >nul && claude' : 'claude'
    this.process = spawn(cmd, args, {
      cwd: this.workDir,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        // Windows 中文编码修复
        ...(isWin && {
          CHCP: '65001',
          PYTHONUTF8: '1',
        }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      // Windows 特殊处理
      ...(isWin && { windowsHide: true }),
    })

    // Capture stderr for debugging
    const stderrChunks: string[] = []
    if (this.process.stderr) {
      this.process.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk.toString())
      })
    }

    // No-output timeout: kill process if it produces nothing on stdout for 120s
    let noOutputTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      this.killProcessTree()
    }, 120_000)

    const resetNoOutputTimer = () => {
      if (noOutputTimer) clearTimeout(noOutputTimer)
      noOutputTimer = setTimeout(() => {
        this.killProcessTree()
      }, 120_000)
    }
    this.process.stdout?.on('data', resetNoOutputTimer)

    // Combine systemPrompt + context + prompt into a single prompt for CLI
    const parts: string[] = []
    if (task.systemPrompt) parts.push(task.systemPrompt)
    if (task.context) parts.push(`背景信息：\n${task.context}`)
    parts.push(task.prompt)
    const fullPrompt = parts.join('\n\n---\n\n')

    // Write combined prompt to stdin then close
    if (this.process.stdin) {
      const buffer = Buffer.from(fullPrompt, 'utf-8')
      this.process.stdin.write(buffer)
      this.process.stdin.end()
    }

    // Wait for process to exit or timeout
    const timeout = setTimeout(() => {
      this.killProcessTree()
    }, 3 * 60 * 1000) // 3 minutes timeout

    try {
      for await (const chunk of this.readProcess(this.process)) {
        yield chunk
      }
    } catch (error) {
      const stderr = stderrChunks.join('')
      throw new Error(`Claude CLI error: ${error}${stderr ? `\nStderr: ${stderr}` : ''}`)
    } finally {
      clearTimeout(timeout)
      if (noOutputTimer) clearTimeout(noOutputTimer)
      this.killProcessTree()
    }
  }

  private async *readProcess(proc: ChildProcess): AsyncIterable<StreamChunk> {
    const stdout = proc.stdout
    if (!stdout) return

    let buffer = ''
    const decoder = new TextDecoder()

    for await (const raw of stdout) {
      buffer += decoder.decode(raw, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)

          // 提取 session_id（在 result 或 init 事件中）
          if (event.session_id && !this.sessionId) {
            this.sessionId = event.session_id
            yield { type: 'session', content: event.session_id }
          }

          // Assistant message with content array
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) {
                yield { type: 'text', content: block.text }
              }
            }
          }
          // Final result — only emit status marker, not text (assistant events already streamed full content)
          else if (event.type === 'result') {
            yield { type: 'status', content: 'completed' }
          }
        } catch {
          // Non-JSON output, skip
        }
      }
    }
  }

  private killProcessTree(): void {
    if (!this.process) return

    const pid = this.process.pid
    if (!pid) return

    // Kill process tree on Windows
    if (process.platform === 'win32') {
      try {
        // Use taskkill to kill entire process tree
        spawn('taskkill', ['/pid', pid.toString(), '/T', '/F'], { shell: false })
      } catch {
        // Fallback to simple kill
        this.process.kill('SIGTERM')
      }
    } else {
      // On Unix, kill process group
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        this.process.kill('SIGTERM')
      }
    }

    this.process = null
  }

  async close(): Promise<void> {
    this.killProcessTree()
    // 不删除工作区 — 下游 Agent 可能需要读取产出文件
    // 清理由 handleExecution 结束时的 cleanupTaskWorkspaces 统一处理
  }
}

import { spawn, type ChildProcess } from 'child_process'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { AgentAdapter, AdapterConfig, AgentTask, StreamChunk } from './types'

export class ClaudeCodeAdapter implements AgentAdapter {
  private workDir: string = ''
  private process: ChildProcess | null = null

  async connect(config: AdapterConfig): Promise<void> {
    this.workDir = config.workDir || join(tmpdir(), `agenthub-${Date.now()}`)
    if (!existsSync(this.workDir)) {
      mkdirSync(this.workDir, { recursive: true })
    }
  }

  async *send(task: AgentTask): AsyncIterable<StreamChunk> {
    // Use stdin to pass prompt (avoids shell escaping issues with Chinese/special chars)
    const args = ['--output-format', 'stream-json', '--verbose', '--bare']

    const isWin = process.platform === 'win32'
    const cmd = isWin ? 'chcp 65001 >nul && claude' : 'claude'
    this.process = spawn(cmd, args, {
      cwd: this.workDir,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    })

    // Capture stderr for debugging
    const stderrChunks: string[] = []
    if (this.process.stderr) {
      this.process.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk.toString())
      })
    }

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

          // Assistant message with content array
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) {
                yield { type: 'text', content: block.text }
              }
            }
          }
          // Final result
          else if (event.type === 'result' && event.result) {
            yield { type: 'text', content: event.result }
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
        spawn('taskkill', ['/pid', pid.toString(), '/T', '/F'], { shell: true })
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
    if (this.workDir && this.workDir.includes('agenthub-')) {
      try { rmSync(this.workDir, { recursive: true, force: true }) } catch {}
    }
  }
}

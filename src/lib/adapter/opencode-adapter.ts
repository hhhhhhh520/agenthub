import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { AgentAdapter, AdapterConfig, AgentTask, StreamChunk } from './types'

export class OpenCodeAdapter implements AgentAdapter {
  private workDir: string = ''
  private process: ChildProcess | null = null
  private sessionId: string | null = null

  async connect(config: AdapterConfig): Promise<void> {
    this.workDir = config.workDir || join(process.cwd(), 'workspaces', `opencode-${Date.now()}`)
    if (!existsSync(this.workDir)) {
      mkdirSync(this.workDir, { recursive: true })
    }
    if (config.sessionId) {
      this.sessionId = config.sessionId
    }
  }

  async *send(task: AgentTask): AsyncIterable<StreamChunk> {
    const args = ['run', '--format', 'json', '--dir', this.workDir]

    if (task.systemPrompt) {
      args.push('--prompt', task.systemPrompt)
    }
    if (this.sessionId) {
      args.push('--session', this.sessionId)
    }

    // Combine context + prompt
    const fullPrompt = task.context
      ? `Context:\n${task.context}\n\n---\n\n${task.prompt}`
      : task.prompt

    const isWin = process.platform === 'win32'
    const cmd = isWin ? 'opencode' : 'opencode'

    this.process = spawn(cmd, args, {
      cwd: this.workDir,
      env: {
        ...process.env,
        OPENCODE_PERMISSION: '{"*":"allow"}',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    })

    // Write prompt to stdin
    if (this.process.stdin) {
      const buffer = Buffer.from(fullPrompt, 'utf-8')
      this.process.stdin.write(buffer)
      this.process.stdin.end()
    }

    // Capture stderr
    const stderrChunks: string[] = []
    if (this.process.stderr) {
      this.process.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk.toString())
      })
    }

    // Timeout: 20 minutes
    const timeout = setTimeout(() => {
      this.killProcess()
    }, 20 * 60 * 1000)

    try {
      for await (const chunk of this.readProcess(this.process)) {
        yield chunk
      }
    } catch (error) {
      const stderr = stderrChunks.join('')
      yield { type: 'error', content: `OpenCode error: ${error}${stderr ? `\nStderr: ${stderr}` : ''}` }
    } finally {
      clearTimeout(timeout)
      this.killProcess()
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

          // Extract session ID
          if (event.sessionID) {
            this.sessionId = event.sessionID
          }

          // Text events
          if (event.type === 'text' && event.part?.text) {
            yield { type: 'text', content: event.part.text }
          }
          // Step finish with content
          else if (event.type === 'step_finish' && event.part?.text) {
            yield { type: 'text', content: event.part.text }
          }
          // Error events
          else if (event.type === 'error') {
            yield { type: 'error', content: event.data?.message || event.message || 'Unknown error' }
          }
        } catch {
          // Non-JSON output, skip
        }
      }
    }
  }

  private killProcess(): void {
    if (!this.process) return
    const pid = this.process.pid
    if (!pid) return

    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', pid.toString(), '/T', '/F'], { shell: true })
      } catch {
        this.process.kill('SIGTERM')
      }
    } else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        this.process.kill('SIGTERM')
      }
    }
    this.process = null
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  async close(): Promise<void> {
    this.killProcess()
  }
}

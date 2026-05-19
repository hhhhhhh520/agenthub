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

    this.process = spawn('claude', args, {
      cwd: this.workDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    })

    // Write prompt to stdin then close
    if (this.process.stdin) {
      this.process.stdin.write(task.prompt)
      this.process.stdin.end()
    }

    const timeout = setTimeout(() => {
      this.process?.kill('SIGTERM')
    }, 5 * 60 * 1000)

    try {
      for await (const chunk of this.readProcess(this.process)) {
        yield chunk
      }
    } finally {
      clearTimeout(timeout)
      this.process = null
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

  async close(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM')
      this.process = null
    }
    if (this.workDir && this.workDir.includes('agenthub-')) {
      try { rmSync(this.workDir, { recursive: true, force: true }) } catch {}
    }
  }
}

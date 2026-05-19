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
    const args = ['-p', task.prompt, '--output-format', 'stream-json']
    if (task.systemPrompt) {
      args.push('--system-prompt', task.systemPrompt)
    }

    this.process = spawn('claude', args, {
      cwd: this.workDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

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
          if (event.type === 'text' || event.type === 'content_block_delta') {
            yield { type: 'text', content: event.text || event.delta?.text || '' }
          } else if (event.type === 'result') {
            yield { type: 'text', content: event.result || '' }
          }
        } catch {
          yield { type: 'text', content: line }
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

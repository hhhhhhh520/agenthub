import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// useChat 没有现成 React 渲染测试环境；用源码守卫钉住会话切换必须做的清理。
// 这是行为级回归的替代：删掉 reset effect 或漏掉任一状态清空都会红。
describe('useChat — P3 #21 会话切换复位', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/hooks/use-chat.ts'), 'utf8')

  it('sessionId 变化时 abort 旧请求并清空消息/流式/权限/工具状态', () => {
    expect(source).toMatch(/useEffect\(\(\) => \{[\s\S]*?abortRef\.current\?\.abort\(\)[\s\S]*?setMessages\(\[\]\)[\s\S]*?setStreaming\(\{\}\)[\s\S]*?setLoading\(false\)[\s\S]*?setPendingPermissions\(\[\]\)[\s\S]*?setThinking\(\{\}\)[\s\S]*?setToolCalls\(\[\]\)[\s\S]*?\}, \[sessionId\]\)/)
  })

  it('复位 effect 同时重置 seq gate，避免新会话继承旧游标', () => {
    expect(source).toMatch(/seqGateRef\.current = createSeqGate\(0\)/)
    expect(source).toMatch(/seqGateRef\.current = createSeqGate\(loadLastSeq\(sessionId\)\)/)
  })
})

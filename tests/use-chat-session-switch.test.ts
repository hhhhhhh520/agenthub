import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequestEpoch } from '@/lib/hooks/latest-request'

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

  it('旧消息加载有独立 abort，并在写 messages 前校验请求世代', () => {
    expect(source).toContain('loadAbortRef')
    expect(source).toContain('requestEpochRef.current.next()')
    expect(source).toContain('requestEpochRef.current.isCurrent(requestId)')
    expect(source).toContain('loadAbortRef.current?.abort()')
  })

  it('发送请求的 catch/finally 只允许当前 controller 清理 loading', () => {
    expect(source).toContain('const isCurrentRequest = () => abortRef.current === controller')
    expect(source).toContain('if (!isCurrentRequest()) return')
    expect(source).toContain('if (abortRef.current === controller)')
  })

  it('旧事件流/节流定时器写状态前核对当前 sessionId', () => {
    expect(source).toContain('sessionIdRef.current !== sessionId')
    expect(source).toContain('sessionIdRef.current !== timerSessionId')
  })
})

describe('createRequestEpoch — 迟到响应抑制', () => {
  it('后发请求完成前，先发请求的迟到响应不得写结果', async () => {
    const epoch = createRequestEpoch()
    const written: string[] = []
    const slow = (async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
      if (epoch.isCurrent(1)) written.push('A')
    })()
    const fast = (async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      if (epoch.isCurrent(2)) written.push('B')
    })()
    epoch.next() // A 请求
    epoch.next() // B 请求覆盖 A
    await Promise.all([slow, fast])
    expect(written).toEqual(['B'])
  })
})

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

// roadmap §3.1 前端重放游标：POST chat 流与 GET events 流双通道并存，同一事件
// 可能两路到达——seq 单调门统一去重。lastSeq 经 sessionStorage 跨刷新恢复，
// EventSource 以 after=lastSeq 精准补发断线窗口（非全量历史回放）。

import { createSeqGate, lastSeqStorageKey, recordLastSeq, loadLastSeq } from '@/lib/events-replay'

describe('createSeqGate — 双通道 seq 去重（§3.1）', () => {
  it('seq 缺失的帧（text/done 等非持久化类型）恒放行，不推进游标', () => {
    const gate = createSeqGate(10)
    expect(gate.accept(undefined)).toBe(true)
    expect(gate.current()).toBe(10)
  })

  it('递增 seq 放行并推进游标；重复/回退拒绝', () => {
    const gate = createSeqGate(0)
    expect(gate.accept(1)).toBe(true)
    expect(gate.accept(2)).toBe(true)
    expect(gate.accept(2)).toBe(false)
    expect(gate.accept(1)).toBe(false)
    expect(gate.accept(3)).toBe(true)
    expect(gate.current()).toBe(3)
  })

  it('initial 语义：起点以下的 seq 全拒（恢复 lastSeq 后跳过历史）', () => {
    const gate = createSeqGate(41)
    expect(gate.accept(40)).toBe(false)
    expect(gate.accept(41)).toBe(false)
    expect(gate.accept(42)).toBe(true)
  })

  it('sessionStorage 键名按 session 区分（跨刷新恢复 lastSeq）', () => {
    expect(lastSeqStorageKey('abc')).toBe('agenthub:lastSeq:abc')
  })

  it('recordLastSeq 取 max 合并（多标签页竞态防回退）；loadLastSeq 恢复', () => {
    // vitest node 环境无 sessionStorage —— 模拟最小实现
    const store = new Map<string, string>()
    const g = globalThis as unknown as { sessionStorage?: Storage }
    const fakeStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
    } as unknown as Storage
    const original = g.sessionStorage
    g.sessionStorage = fakeStorage
    try {
      recordLastSeq('s1', 5)
      recordLastSeq('s1', 9)
      recordLastSeq('s1', 7) // 旧 tab 慢帧——不回退
      expect(loadLastSeq('s1')).toBe(9)
      expect(loadLastSeq('no-such')).toBe(0)
    } finally {
      g.sessionStorage = original
    }
  })
})

describe('use-chat.ts EventSource 接线守卫（§3.1）', () => {
  it('use-chat 必须建立 EventSource、使用 seqGate、处理 replay 标记', () => {
    const src = readFileSync(new URL('../src/lib/hooks/use-chat.ts', import.meta.url), 'utf-8')
    // 弱绊线：防"接线整体遗忘"（纯逻辑有单测，这里只锁接线存在性）
    expect(src).toContain('new EventSource(')
    expect(src).toContain('createSeqGate(')
    expect(src).toContain('recordLastSeq')
    expect(src).toContain('loadLastSeq')
    expect(src).toContain('event.replay')
  })
})

import { describe, expect, it } from 'vitest'
import { add } from '@/utils/math'

describe('add', () => {
  it('正整数相加', () => {
    expect(add(1, 2)).toBe(3)
  })

  it('负数相加', () => {
    expect(add(-1, -2)).toBe(-3)
  })

  it('正负混合抵消', () => {
    expect(add(-1, 1)).toBe(0)
  })

  it('与零相加', () => {
    expect(add(0, 5)).toBe(5)
  })

  it('小数相加（浮点精度用 toBeCloseTo）', () => {
    expect(add(0.1, 0.2)).toBeCloseTo(0.3)
  })
})

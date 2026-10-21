import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { markSeedFailure } from '../prisma/seed-utils'

const originalExitCode = process.exitCode

afterEach(() => {
  process.exitCode = originalExitCode
  vi.restoreAllMocks()
})

describe('seed failure contract', () => {
  it('记录错误并把进程退出码设为 1（CI/脚本不会把失败当成功）', () => {
    const error = new Error('seed boom')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = undefined

    markSeedFailure(error)

    expect(log).toHaveBeenCalledWith(error)
    expect(process.exitCode).toBe(1)
  })

  it('prisma/seed.ts 的 main() 失败路径接到 markSeedFailure', () => {
    const src = readFileSync(resolve(__dirname, '../prisma/seed.ts'), 'utf-8')
    expect(src).toContain("import { markSeedFailure } from './seed-utils'")
    expect(src).toContain('.catch(markSeedFailure)')
  })
})

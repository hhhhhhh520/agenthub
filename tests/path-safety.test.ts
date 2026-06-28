import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// Mock realpathSync to control symlink behavior
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof fs>('fs')
  return { ...actual, realpathSync: vi.fn(actual.realpathSync) }
})

import { isPathSafe } from '@/lib/path-safety'

const WORK_DIR = path.resolve('/home/user/project')

describe('isPathSafe', () => {
  beforeEach(() => {
    vi.mocked(fs.realpathSync).mockImplementation((p: fs.PathLike) => String(p))
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── 正常路径 ──

  it('允许项目根目录本身', () => {
    expect(isPathSafe('.', WORK_DIR)).toBe(true)
  })

  it('允许项目内文件', () => {
    expect(isPathSafe('src/index.ts', WORK_DIR)).toBe(true)
  })

  it('允许嵌套目录文件', () => {
    expect(isPathSafe('src/lib/utils.ts', WORK_DIR)).toBe(true)
  })

  it('允许同名文件', () => {
    expect(isPathSafe('package.json', WORK_DIR)).toBe(true)
  })

  // ── 路径遍历攻击 ──

  it('拒绝 ../ 遍历', () => {
    expect(isPathSafe('../etc/passwd', WORK_DIR)).toBe(false)
  })

  it('拒绝多层 ../ 遍历', () => {
    expect(isPathSafe('../../etc/passwd', WORK_DIR)).toBe(false)
  })

  it('拒绝中间带 ../ 的路径', () => {
    expect(isPathSafe('src/../../../etc/passwd', WORK_DIR)).toBe(false)
  })

  it('拒绝 .. 本身', () => {
    expect(isPathSafe('..', WORK_DIR)).toBe(false)
  })

  // ── 绝对路径 ──

  it('拒绝指向 workDir 外部的绝对路径', () => {
    const outside = path.resolve(WORK_DIR, '..', '..', 'etc', 'passwd')
    expect(isPathSafe(outside, WORK_DIR)).toBe(false)
  })

  // ── 空路径和边界 ──

  it('允许空字符串（解析为 workDir 本身）', () => {
    expect(isPathSafe('', WORK_DIR)).toBe(true)
  })

  it('允许 ./ 前缀', () => {
    expect(isPathSafe('./src/index.ts', WORK_DIR)).toBe(true)
  })

  // ── 符号链接攻击 ──

  it('拒绝指向 workDir 外部的符号链接', () => {
    vi.mocked(fs.realpathSync).mockImplementation((p: fs.PathLike) => {
      const s = String(p)
      if (s.includes('evil-link')) return path.resolve(WORK_DIR, '..', '..', 'etc', 'passwd')
      return s
    })
    expect(isPathSafe('evil-link', WORK_DIR)).toBe(false)
  })

  it('允许指向 workDir 内部的符号链接', () => {
    let callCount = 0
    vi.mocked(fs.realpathSync).mockImplementation((p: fs.PathLike) => {
      callCount++
      const s = String(p)
      if (callCount === 1) return s
      return path.join(WORK_DIR, 'real-file.ts')
    })
    expect(isPathSafe('safe-link', WORK_DIR)).toBe(true)
  })

  // ── workDir 含特殊字符 ──

  it('workDir 含空格时正常工作', () => {
    const dir = path.resolve('/home/user/my project')
    expect(isPathSafe('src/index.ts', dir)).toBe(true)
    expect(isPathSafe('../other', dir)).toBe(false)
  })

  // ── 文件不存在时的 fallback ──

  it('文件不存在时用 resolve+startsWith fallback', () => {
    // 不 mock，使用真实的 resolve 逻辑
    vi.mocked(fs.realpathSync).mockImplementation((p: fs.PathLike) => {
      const s = String(p)
      if (s.includes('nonexistent')) throw new Error('ENOENT')
      return s
    })
    expect(isPathSafe('nonexistent/file.ts', WORK_DIR)).toBe(true)
    expect(isPathSafe('../nonexistent', WORK_DIR)).toBe(false)
  })
})

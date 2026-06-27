/**
 * execution.ts 越界清理逻辑测试
 *
 * 验证：普通越界文件清理 + 其他批次文件保护 + undeclared 清空
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { cleanupUndeclared, normalizePath } from '@/lib/services/execution'

describe('越界清理逻辑（边界检测阶段）', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('应清理不属于任何批次的越界文件', () => {
    const orphanFile = path.join(tmpDir, 'orphan.py')
    fs.writeFileSync(orphanFile, '# orphan')

    const undeclared = ['orphan.py']
    const result = cleanupUndeclared(undeclared, [], tmpDir)

    expect(result.cleanedCount).toBe(1)
    expect(result.protectedCount).toBe(0)
    expect(fs.existsSync(orphanFile)).toBe(false)
  })

  it('不应清理属于其他批次的文件', () => {
    const otherFile = path.join(tmpDir, 'cli.py')
    fs.writeFileSync(otherFile, '# cli code')

    const undeclared = ['cli.py']
    const result = cleanupUndeclared(undeclared, ['cli.py'], tmpDir)

    expect(result.cleanedCount).toBe(0)
    expect(result.protectedCount).toBe(1)
    expect(fs.existsSync(otherFile)).toBe(true)
  })

  it('应混合处理：清理一部分，保护一部分', () => {
    const orphanFile = path.join(tmpDir, 'debug.log')
    const protectedFile = path.join(tmpDir, 'cli.py')
    fs.writeFileSync(orphanFile, '# debug')
    fs.writeFileSync(protectedFile, '# cli')

    const undeclared = ['debug.log', 'cli.py']
    const result = cleanupUndeclared(undeclared, ['cli.py'], tmpDir)

    expect(result.cleanedCount).toBe(1)
    expect(result.protectedCount).toBe(1)
    expect(fs.existsSync(orphanFile)).toBe(false)
    expect(fs.existsSync(protectedFile)).toBe(true)
  })

  it('文件不存在时不应崩溃', () => {
    const undeclared = ['nonexistent.py']
    const result = cleanupUndeclared(undeclared, [], tmpDir)

    expect(result.cleanedCount).toBe(0)
    expect(result.protectedCount).toBe(0)
  })

  it('undeclared 为空时应返回空结果', () => {
    const result = cleanupUndeclared([], [], tmpDir)

    expect(result.cleanedCount).toBe(0)
    expect(result.protectedCount).toBe(0)
  })

  it('路径归一化应正确处理 Windows 路径', () => {
    expect(normalizePath('todo\\cli.py')).toBe('todo/cli.py')
    expect(normalizePath('./todo/cli.py')).toBe('todo/cli.py')
    expect(normalizePath('Todo/CLI.PY')).toBe('todo/cli.py')
  })

  it('清理后 undeclared 数组应被清空', () => {
    const undeclared = ['file1.py', 'file2.py']
    cleanupUndeclared(undeclared, [], tmpDir)

    expect(undeclared.length).toBe(0)
  })

  it('清空后监控审查应看不到越界文件', () => {
    const undeclared = ['orphan.py']
    const auditResult = { declared: ['core.py'], undeclared }

    cleanupUndeclared(undeclared, [], tmpDir)

    // 验证 auditResult.undeclared 也被清空（因为是同一个引用）
    expect(auditResult.undeclared.length).toBe(0)
  })
})

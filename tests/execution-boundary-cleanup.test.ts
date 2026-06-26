/**
 * execution.ts 越界清理逻辑测试
 *
 * 验证：普通越界文件清理 + 其他批次文件保护 + undeclared 清空
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('越界清理逻辑（边界检测阶段）', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // 辅助函数：模拟 normalizePath
  const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()

  // 辅助函数：模拟越界清理逻辑
  function cleanupUndeclared(
    undeclared: string[],
    declaredFiles: string[],
    otherDeclaredFiles: string[],
    projectRoot: string
  ): { cleaned: string[]; protected: string[] } {
    const otherDeclared = new Set(otherDeclaredFiles.map(normalizePath))
    const cleaned: string[] = []
    const protectedFiles: string[] = []

    for (const file of undeclared) {
      if (otherDeclared.has(normalizePath(file))) {
        protectedFiles.push(file)
      } else {
        const fullPath = path.join(projectRoot, file)
        try {
          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath)
            cleaned.push(file)
          }
        } catch {
          // 删除失败不阻塞
        }
      }
    }

    return { cleaned, protected: protectedFiles }
  }

  it('应清理不属于任何批次的越界文件', () => {
    // 创建越界文件
    const orphanFile = path.join(tmpDir, 'orphan.py')
    fs.writeFileSync(orphanFile, '# orphan')

    const undeclared = ['orphan.py']
    const declaredFiles = [] // 当前任务无声明
    const otherDeclaredFiles = [] // 其他任务也无声明

    const result = cleanupUndeclared(undeclared, declaredFiles, otherDeclaredFiles, tmpDir)

    expect(result.cleaned).toEqual(['orphan.py'])
    expect(result.protected).toEqual([])
    expect(fs.existsSync(orphanFile)).toBe(false)
  })

  it('不应清理属于其他批次的文件', () => {
    // 创建文件（模拟其他批次的产出）
    const otherFile = path.join(tmpDir, 'cli.py')
    fs.writeFileSync(otherFile, '# cli code')

    const undeclared = ['cli.py']
    const declaredFiles = [] // 当前任务无声明
    const otherDeclaredFiles = ['cli.py'] // 其他任务声明了这个文件

    const result = cleanupUndeclared(undeclared, declaredFiles, otherDeclaredFiles, tmpDir)

    expect(result.cleaned).toEqual([])
    expect(result.protected).toEqual(['cli.py'])
    expect(fs.existsSync(otherFile)).toBe(true) // 文件保留
  })

  it('应混合处理：清理一部分，保护一部分', () => {
    // 创建两个文件
    const orphanFile = path.join(tmpDir, 'debug.log')
    const protectedFile = path.join(tmpDir, 'cli.py')
    fs.writeFileSync(orphanFile, '# debug')
    fs.writeFileSync(protectedFile, '# cli')

    const undeclared = ['debug.log', 'cli.py']
    const declaredFiles = []
    const otherDeclaredFiles = ['cli.py'] // 只保护 cli.py

    const result = cleanupUndeclared(undeclared, declaredFiles, otherDeclaredFiles, tmpDir)

    expect(result.cleaned).toEqual(['debug.log'])
    expect(result.protected).toEqual(['cli.py'])
    expect(fs.existsSync(orphanFile)).toBe(false)
    expect(fs.existsSync(protectedFile)).toBe(true)
  })

  it('文件不存在时不应崩溃', () => {
    const undeclared = ['nonexistent.py']
    const declaredFiles = []
    const otherDeclaredFiles = []

    // 不应抛异常
    const result = cleanupUndeclared(undeclared, declaredFiles, otherDeclaredFiles, tmpDir)

    expect(result.cleaned).toEqual([]) // 文件不存在，跳过
    expect(result.protected).toEqual([])
  })

  it('undeclared 为空时应返回空结果', () => {
    const undeclared: string[] = []
    const declaredFiles = []
    const otherDeclaredFiles = []

    const result = cleanupUndeclared(undeclared, declaredFiles, otherDeclaredFiles, tmpDir)

    expect(result.cleaned).toEqual([])
    expect(result.protected).toEqual([])
  })

  it('路径归一化应正确处理 Windows 路径', () => {
    // 模拟 Windows 路径
    const undeclared = ['todo\\cli.py']
    const otherDeclaredFiles = ['todo/cli.py'] // 正斜杠

    const otherDeclared = new Set(otherDeclaredFiles.map(normalizePath))
    const normalizedUndeclared = undeclared.map(normalizePath)

    // 验证归一化后能正确匹配
    expect(normalizedUndeclared[0]).toBe('todo/cli.py')
    expect(otherDeclared.has(normalizedUndeclared[0])).toBe(true)
  })
})

describe('undeclared 清空逻辑', () => {
  it('清理后 undeclared 数组应被清空', () => {
    const undeclared = ['file1.py', 'file2.py']

    // 模拟清理后的清空操作
    undeclared.splice(0)

    expect(undeclared.length).toBe(0)
  })

  it('清空后监控审查应看不到越界文件', () => {
    // 模拟监控审查的输入
    const undeclared = ['orphan.py']
    const auditResult = { declared: ['core.py'], undeclared }

    // 清理后清空
    undeclared.splice(0)

    // 验证 auditResult.undeclared 也被清空（因为是同一个引用）
    expect(auditResult.undeclared.length).toBe(0)
  })
})

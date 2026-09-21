import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, basename } from 'path'
import { listDirTree, listProjectFiles } from '../src/lib/list-dir'

describe('listDirTree — 目录列举（不跟进符号链接/junction）', () => {
  let root: string
  let outside: string
  let sibling: string
  let linkCreated = false
  let brokenLinkCreated = false

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'agenthub-list-'))
    outside = mkdtempSync(join(tmpdir(), 'agenthub-outside-'))
    sibling = root + '-evil'
    mkdirSync(sibling)
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'README.md'), 'x')
    writeFileSync(join(root, 'src', 'app.ts'), 'x')
    writeFileSync(join(outside, 'SALARY-2026.xlsx'), 'secret')
    writeFileSync(join(sibling, 'ESCAPE.txt'), 'x')
    try {
      symlinkSync(outside, join(root, 'hr'), 'junction')
      linkCreated = true
    } catch {
      linkCreated = false
    }
    try {
      symlinkSync(join(outside, 'nonexistent-target'), join(root, 'broken-link'), 'junction')
      brokenLinkCreated = true
    } catch {
      brokenLinkCreated = false
    }
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
    rmSync(sibling, { recursive: true, force: true })
  })

  it('列出文件与目录，带 [D]/[F] 前缀且路径相对于根', () => {
    const out = listDirTree(root)
    expect(out).toContain('[F] README.md')
    expect(out).toContain('[D] src')
    expect(out).toContain(`[F] ${join('src', 'app.ts')}`)
  })

  it('不跟进符号链接/junction（不泄漏沙箱外文件名，也不列出链接本身）', (ctx) => {
    if (!linkCreated) return ctx.skip()
    const out = listDirTree(root).join('\n')
    expect(out).not.toContain('SALARY-2026')
    expect(out).not.toContain('hr')
  })

  it('悬空符号链接被跳过且不抛错', (ctx) => {
    if (!brokenLinkCreated) return ctx.skip()
    expect(() => listDirTree(root)).not.toThrow()
    expect(listDirTree(root).join('\n')).not.toContain('broken-link')
  })

  it('空目录返回空数组', () => {
    const empty = mkdtempSync(join(tmpdir(), 'agenthub-empty-'))
    try {
      expect(listDirTree(empty)).toEqual([])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('listProjectFiles — 端到端（真实目录，覆盖 realpath 分支）', () => {
  let root: string
  let sibling: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'agenthub-e2e-'))
    sibling = root + '-evil'
    mkdirSync(sibling)
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'app.ts'), 'x')
    writeFileSync(join(sibling, 'ESCAPE.txt'), 'x')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(sibling, { recursive: true, force: true })
  })

  it('拒绝越界目录（父目录）', () => {
    expect(listProjectFiles('..', root)).toBe('错误：路径超出项目目录')
  })

  it('拒绝前缀同族目录（真实存在的 sibling，走 realpath 分支）', () => {
    expect(listProjectFiles(`../${basename(sibling)}`, root)).toBe('错误：路径超出项目目录')
  })

  it('允许列出子目录内容', () => {
    expect(listProjectFiles('src', root)).toContain('[F] app.ts')
  })

  it('根目录列举不泄漏 sibling 内容', () => {
    expect(listProjectFiles(undefined, root)).not.toContain('ESCAPE')
  })
})

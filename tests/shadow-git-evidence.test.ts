import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { cleanupShadowGit, getChangedFilesDetailed, getGitSnapshotDetailed } from '@/lib/services/shadow-git'
import { auditBatchChanges } from '@/lib/services/execution'

// P1-01 审计内容证据：路径 Set 会漏掉“批次前已脏、批次中再次修改”的同一路径，
// 也不会包含被 .gitignore 忽略的 .env。这里用真实临时目录 + 真实 git 锁定证据语义。
describe('shadow-git 内容证据', () => {
  let root: string
  const SESSION = 'evidence-session'

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-evidence-'))
  })

  afterEach(() => {
    try {
      cleanupShadowGit(root, SESSION)
      fs.rmSync(root, { recursive: true, force: true })
    } catch {}
  })

  it('已脏的 package.json 再次修改，仍能被识别为变化', () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"v":1}\n')
    const init = getGitSnapshotDetailed(root, SESSION)
    expect(init.ok).toBe(true)

    // 让 package.json 在批次开始前处于已脏状态，并记录该时点的内容证据
    fs.writeFileSync(path.join(root, 'package.json'), '{"v":2}\n')
    const before = getGitSnapshotDetailed(root, SESSION)
    expect(before).toHaveProperty('evidence')
    if (!before.ok) throw new Error(before.reason)

    // 批次中再次修改同一路径
    fs.writeFileSync(path.join(root, 'package.json'), '{"v":3}\n')
    const changed = getChangedFilesDetailed(root, SESSION, before.evidence)

    expect(changed).toEqual({ ok: true, files: expect.arrayContaining(['package.json']) })
  })

  it('被 .gitignore 忽略的 .env 内容变化，仍能被识别', () => {
    fs.writeFileSync(path.join(root, '.gitignore'), '.env\n')
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=one\n')
    const init = getGitSnapshotDetailed(root, SESSION)
    expect(init).toHaveProperty('evidence')
    if (!init.ok) throw new Error(init.reason)

    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=two\n')
    const changed = getChangedFilesDetailed(root, SESSION, init.evidence)

    expect(changed).toEqual({ ok: true, files: expect.arrayContaining(['.env']) })
  })

  it('被忽略目录下的 .env 变化，仍能被识别', () => {
    fs.writeFileSync(path.join(root, '.gitignore'), 'secrets/\n')
    fs.mkdirSync(path.join(root, 'secrets'), { recursive: true })
    fs.writeFileSync(path.join(root, 'secrets', '.env'), 'TOKEN=one\n')
    const before = getGitSnapshotDetailed(root, SESSION)
    expect(before).toHaveProperty('evidence')
    if (!before.ok) throw new Error(before.reason)

    fs.writeFileSync(path.join(root, 'secrets', '.env'), 'TOKEN=two\n')
    const changed = getChangedFilesDetailed(root, SESSION, before.evidence)

    expect(changed).toEqual({ ok: true, files: expect.arrayContaining(['secrets/.env']) })
  })

  it('审计消费内容证据：已脏 package.json 再次修改 → violation', () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"v":1}\n')
    const init = getGitSnapshotDetailed(root, SESSION)
    expect(init.ok).toBe(true)

    fs.writeFileSync(path.join(root, 'package.json'), '{"v":2}\n')
    const before = getGitSnapshotDetailed(root, SESSION)
    expect(before).toHaveProperty('evidence')
    if (!before.ok) throw new Error(before.reason)

    fs.writeFileSync(path.join(root, 'package.json'), '{"v":3}\n')
    const audit = auditBatchChanges(root, SESSION, before.evidence, [{ declaredFiles: '["src/app.ts"]' }])

    expect(audit.status).toBe('violation')
    if (audit.status === 'violation') {
      expect(audit.sensitiveViolations).toContain('package.json')
    }
  })

  it('审计消费内容证据：未声明的 .env 变化 → violation', () => {
    fs.writeFileSync(path.join(root, '.gitignore'), '.env\n')
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=one\n')
    const before = getGitSnapshotDetailed(root, SESSION)
    expect(before).toHaveProperty('evidence')
    if (!before.ok) throw new Error(before.reason)

    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=two\n')
    const audit = auditBatchChanges(root, SESSION, before.evidence, [{ declaredFiles: '["src/app.ts"]' }])

    expect(audit.status).toBe('violation')
    if (audit.status === 'violation') {
      expect(audit.sensitiveViolations).toContain('.env')
    }
  })

  it('批次中删除已存在的未跟踪文件，仍能被识别', () => {
    fs.writeFileSync(path.join(root, 'delete-me.tmp'), 'temporary\n')
    const before = getGitSnapshotDetailed(root, SESSION)
    expect(before).toHaveProperty('evidence')
    if (!before.ok) throw new Error(before.reason)

    fs.unlinkSync(path.join(root, 'delete-me.tmp'))
    const changed = getChangedFilesDetailed(root, SESSION, before.evidence)

    expect(changed).toEqual({ ok: true, files: expect.arrayContaining(['delete-me.tmp']) })
  })

  it('内容未变化的已脏路径不误报', () => {
    fs.writeFileSync(path.join(root, 'stable.txt'), 'same\n')
    const before = getGitSnapshotDetailed(root, SESSION)
    expect(before).toHaveProperty('evidence')
    if (!before.ok) throw new Error(before.reason)

    const changed = getChangedFilesDetailed(root, SESSION, before.evidence)

    expect(changed).toEqual({ ok: true, files: [] })
  })
})

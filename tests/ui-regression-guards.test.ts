import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

// 这些 UI 行为缺少 DOM 测试环境；用源码接线守卫钉住关键接线，防止修复被后续重构静默删掉。
describe('P3 #21/#23/#24/#25/#26 UI 接线守卫', () => {
  it('#23 附件使用函数式更新，上传中禁止发送', () => {
    const input = read('src/components/attachment-input.tsx')
    const chat = read('src/components/chat-area.tsx')
    expect(input).toContain('onAttachmentsChange(prev => appendPlaceholders(prev, placeholders))')
    expect(input).toContain('onAttachmentsChange(prev => mergeUploaded(prev, placeholders, result))')
    expect(chat).toContain('attachments.some(a => a.uploading)')
  })

  it('#24 连接测试不先保存，完成/跳过保存检查 res.ok', () => {
    const wizard = read('src/components/setup-wizard.tsx')
    const testBlock = wizard.slice(wizard.indexOf('const testConnection'), wizard.indexOf('const handleComplete'))
    expect(testBlock).not.toContain("fetch('/api/config/orchestrator'")
    expect(wizard).toContain("assertOkResponse(saveRes, '保存配置失败')")
    expect(wizard).toContain("assertOkResponse(completeRes, '保存完成状态失败')")
  })

  it('#25 服务商导入 await 成功后提示/关闭，调用方检查 res.ok', () => {
    const dialog = read('src/components/provider-import-dialog.tsx')
    expect(dialog).toContain('await onImport(')
    expect(dialog).toContain('setImporting(true)')
    expect(read('src/app/(dashboard)/agents/page.tsx')).toContain("assertOkResponse(res, '导入服务商失败')")
  })

  it('#26 diff 失败可见、Dialog 有 aria/焦点管理、移动端有侧栏入口', () => {
    const chat = read('src/components/chat-area.tsx')
    const dialog = read('src/components/ui/dialog.tsx')
    const layout = read('src/app/(dashboard)/layout.tsx')
    expect(chat).toContain('toast.error(e instanceof Error ? e.message : \'接受文件失败\')')
    expect(dialog).toContain('role="dialog"')
    expect(dialog).toContain('aria-modal="true"')
    expect(dialog).toContain('FOCUSABLE')
    expect(layout).toContain('SidebarTrigger')
    expect(layout).toContain('md:hidden')
  })

  it('#22 项目页接入 permission_request/cancel 与批准 POST', () => {
    const page = read('src/app/(dashboard)/projects/[id]/page.tsx')
    expect(page).toContain('applyProjectPermissionEvent')
    expect(page).toContain("behavior")
    expect(page).toContain('/permission`')
  })
})

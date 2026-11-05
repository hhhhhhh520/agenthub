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
    expect(testBlock).toContain("body: JSON.stringify({ apiKey, model, baseUrl })")
    expect(testBlock).toContain("headers: { 'Content-Type': 'application/json' }")
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

describe('U5 OpenCode 权限默认接线', () => {
  it('创建群聊强制自动模式，已有会话提示可切换', () => {
    const dialog = read('src/components/create-group-dialog.tsx')
    const chat = read('src/components/chat-area.tsx')
    const panel = read('src/components/agent-panel.tsx')

    expect(dialog).toContain('resolveSessionPermissionMode')
    expect(dialog).toContain('permissionMode: effectivePermissionMode')
    expect(chat).toContain("addEventListener('agenthub:members-changed'")
    expect(chat).toContain('切换自动模式')
    expect(panel).toContain("dispatchEvent(new Event('agenthub:members-changed'))")
  })
})

describe('U7 会话管理接线', () => {
  it('会话卡片直接进聊天，详情与重命名/删除确认独立', () => {
    const dashboard = read('src/app/(dashboard)/page.tsx')
    const sidebar = read('src/components/session-sidebar.tsx')

    expect(dashboard).toContain('href={`/chat?session=${session.id}`}')
    expect(dashboard).toContain('SessionActionsMenu')
    expect(sidebar).toContain('SessionActionsMenu')
    expect(sidebar).toContain('SessionRenameDialog')
    expect(sidebar).toContain('SessionConfirmDialog')
  })

  it('首条消息自动命名并在发消息后刷新侧栏', () => {
    const chatRoute = read('src/app/api/sessions/[id]/chat/route.ts')
    const useChat = read('src/lib/hooks/use-chat.ts')
    const useSessions = read('src/lib/hooks/use-sessions.ts')

    expect(chatRoute).toContain('maybeAutoTitleSession')
    expect(chatRoute).toContain('currentTitle: currentSession.title')
    expect(useChat).toContain("dispatchEvent(new Event('agenthub:sessions-changed'))")
    expect(useSessions).toContain("addEventListener('agenthub:sessions-changed'")
  })

  it('已归档筛选只返回归档会话', () => {
    const sessionsRoute = read('src/app/api/sessions/route.ts')
    expect(sessionsRoute).toContain('showArchived ? { isArchived: true } : { isArchived: false }')
  })
})

describe('U12 历史消息卫生接线', () => {
  it('旧「已自动清理」文案在展示层标记为历史记录并改写当前规则', () => {
    const events = read('src/lib/system-events.ts')
    const drawer = read('src/components/system-event-drawer.tsx')

    expect(events).toContain('已自动清理')
    expect(events).toContain('历史记录，规则已更新')
    expect(events).toContain('共享项目目录不自动删除，请人工确认')
    expect(drawer).toContain('历史记录 · 规则已更新')
  })
})

describe('U11 首次使用引导接线', () => {
  it('Setup Wizard 完成后展示 3 步 checklist', () => {
    const wizard = read('src/components/setup-wizard.tsx')
    expect(wizard).toContain('ONBOARDING_CHECKLIST')
    expect(wizard).toContain('开始使用')
  })

  it('空工作区提供示例需求并预填创建群聊', () => {
    const dashboard = read('src/app/(dashboard)/page.tsx')
    const createGroup = read('src/components/create-group-dialog.tsx')
    expect(dashboard).toContain('EXAMPLE_PROMPTS')
    expect(dashboard).toContain('initialTask={createGroupSeed}')
    expect(createGroup).toContain('initialTask')
    expect(createGroup).toContain('对齐三拍')
  })

  it('首次任务完成提示产物位置，且只提示一次', () => {
    const chat = read('src/components/chat-area.tsx')
    expect(chat).toContain('COMPLETION_GUIDE_KEY')
    expect(chat).toContain('Diff 可直接 Accept/Reject')
  })
})

describe('U10 耗时与等待状态接线', () => {
  it('Header 显示会话 elapsed、等待原因与等待时长', () => {
    const header = read('src/components/session-header.tsx')
    const chat = read('src/components/chat-area.tsx')

    expect(header).toContain('sessionStartedAt')
    expect(header).toContain('waitingReason')
    expect(header).toContain('waitingSince')
    expect(chat).toContain('deriveWaitingReason')
    expect(chat).toContain('sessionStartedAt={sessionMeta?.createdAt}')
  })

  it('TaskCard 显示任务耗时，优先使用 trace start', () => {
    const card = read('src/components/task-card.tsx')
    const timing = read('src/lib/task-timing.ts')

    expect(card).toContain('TaskDuration')
    expect(card).toContain('getTaskStartedAt')
    expect(timing).toContain("entry?.event !== 'start'")
  })
})

describe('U9 Agent 状态一致性', () => {
  it('智能体页读 SessionMember 聚合字段，不读 deprecated Agent.status', () => {
    const agentsPage = read('src/app/(dashboard)/agents/page.tsx')
    const agentsRoute = read('src/app/api/agents/route.ts')

    expect(agentsPage).toContain('workingSessionCount')
    expect(agentsPage).toContain('currentSession')
    expect(agentsPage).not.toContain('agent.status')
    expect(agentsRoute).toContain('summarizeAgentPresence')
    expect(agentsRoute).not.toContain('status:true')
  })
})

describe('U8 视觉层级与文案接线', () => {
  it('用户气泡收到 60%，Agent 气泡加宽并带时间戳', () => {
    const chat = read('src/components/chat-area.tsx')

    expect(chat).toContain('max-w-[85%] sm:max-w-[60%]')
    expect(chat).toContain('max-w-[92%] sm:max-w-[86%]')
    expect(chat).toContain('formatMessageClock')
    expect(chat).toContain('formatMessageFullTime')
  })

  it('术语统一为智能体/任务，移除 10–11px 正文字号', () => {
    const panel = read('src/components/agent-panel.tsx')
    const task = read('src/components/task-card.tsx')

    expect(panel).toContain('智能体 ({agents.length})')
    expect(panel).toContain('任务 ({tasks.length})')
    expect(panel).not.toContain('Agents (')
    expect(panel).not.toContain('Tasks (')
    expect(panel).not.toContain('text-[11px]')
    expect(task).toContain('轨迹 {traceCount}')
    expect(task).not.toContain('text-[11px]')
  })

  it('无会话/无任务/无消息都有下一步提示', () => {
    const chat = read('src/components/chat-area.tsx')
    const panel = read('src/components/agent-panel.tsx')
    const sidebar = read('src/components/session-sidebar.tsx')
    const empty = read('src/components/empty-state.tsx')

    expect(empty).toContain('一句现状 + 一句下一步')
    expect(chat).toContain('还没有消息')
    expect(chat).toContain('选择一个会话开始')
    expect(panel).toContain('暂无任务')
    expect(sidebar).toContain('还没有会话')
  })
})

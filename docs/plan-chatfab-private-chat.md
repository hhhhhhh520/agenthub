# ChatFab 私聊功能实现计划

> 创建时间: 2026-05-29 | 状态: ✅ 已实施 (2026-05-31)

## 目标

将右下角的 `ChatFab` 组件从 Mock 数据改为真实 API，实现与单个 Agent 的私聊功能。

## 实现后效果

1. 点击右下角浮动按钮 → 弹出聊天面板
2. 选择一个 Agent（从数据库获取，非 Mock）→ 自动创建/恢复私聊 Session
3. 输入消息 → Agent 实时流式回复（SSE）
4. Agent 可修改本地文件，敏感操作弹出权限确认条
5. 关闭再打开 → 继续上次的对话，历史消息保留

---

## 改动文件清单

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `src/components/chat-fab.tsx` | **重写** | 核心改动，接入真实 API |
| `src/lib/hooks/use-chat-fab.ts` | **新建** | 提取私聊逻辑为独立 hook |
| `src/app/api/sessions/route.ts` | **微调** | 支持 `projectDir` 参数传入私聊 |
| 无需改动 | - | 后端私聊路由已完整实现 |

---

## 详细改动方案

### 1. 新建 `src/lib/hooks/use-chat-fab.ts`

提取私聊逻辑为独立 hook，职责：
- 管理当前私聊 Session（每个 Agent 一个）
- 从 `/api/agents` 获取 Agent 列表
- 创建/恢复私聊 Session
- 复用 `useChat` 的 SSE 消息处理

```typescript
// 伪代码结构
export function useChatFab() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [projectDir, setProjectDir] = useState<string>('')

  // 复用 useChat hook
  const { messages, streaming, loading, send, stop, loadMessages, pendingPermissions, respondPermission } = useChat(sessionId)

  // 初始化：获取 Agent 列表 + 最近项目目录
  useEffect(() => {
    fetch('/api/agents').then(r => r.json()).then(setAgents)
    fetch('/api/recent-dirs').then(r => r.json()).then(dirs => {
      if (dirs[0]) setProjectDir(dirs[0].path)
    })
  }, [])

  // 选择 Agent 时：查找或创建私聊 Session
  const selectAgent = async (agent: Agent) => {
    setSelectedAgent(agent)
    // 查找是否已有该 Agent 的私聊 Session
    const res = await fetch(`/api/sessions?type=private&agentId=${agent.id}`)
    const sessions = await res.json()
    if (sessions[0]) {
      setSessionId(sessions[0].id)
    } else {
      // 创建新私聊 Session
      const session = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `私聊: ${agent.name}`,
          type: 'private',
          projectDir, // 关键：传入项目目录，让 Agent 能改文件
        }),
      }).then(r => r.json())
      // 添加 Agent 为成员
      await fetch(`/api/sessions/${session.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: agent.id }),
      })
      setSessionId(session.id)
    }
  }

  return { agents, selectedAgent, selectAgent, messages, streaming, loading, send, stop, pendingPermissions, respondPermission, projectDir, setProjectDir }
}
```

### 2. 重写 `src/components/chat-fab.tsx`

**删除内容：**
- 第 8-15 行：`MOCK_AGENTS` 数组（删除）
- 第 59-71 行：Mock 回复的 `setTimeout` 逻辑（删除）

**新增/修改内容：**

```typescript
// 第 3 行后新增 import
import { useChatFab } from '@/lib/hooks/use-chat-fab'
import { Shield } from 'lucide-react'
import { Button } from '@/components/ui/button'

// 第 32 行起，组件内部替换为：
export function ChatFab() {
  const {
    agents,
    selectedAgent,
    selectAgent,
    messages,
    streaming,
    loading,
    send,
    stop,
    pendingPermissions,
    respondPermission,
    projectDir,
    setProjectDir,
  } = useChatFab()

  const [isOpen, setIsOpen] = useState(false)
  const [isMinimized, setIsMinimized] = useState(false)
  const [showAgentPicker, setShowAgentPicker] = useState(false)
  const [input, setInput] = useState('')
  const [unread, setUnread] = useState(0)
  const bottomRef = useRef<HTMLDivElement>(null)

  // 滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming])

  // 发送消息
  const handleSend = (text?: string) => {
    const content = text || input.trim()
    if (!content || !selectedAgent) return
    send(content)
    setInput('')
  }

  // 新对话：切换 Agent 时重置
  const handleNewChat = () => {
    setSelectedAgent(null)
    // 不清空 messages，因为切换 Agent 会触发 selectAgent 重新加载
  }

  // ... 其余 UI 代码保持类似结构，但：
  // 1. Agent Picker 从 agents 列表渲染（非 MOCK_AGENTS）
  // 2. 消息列表从 messages 状态渲染（非 Mock）
  // 3. 流式响应显示 streaming[selectedAgent.name]
  // 4. 权限确认条显示 pendingPermissions
}
```

**UI 关键改动点：**

1. **Agent Picker（第 125-144 行区域）**
   - 数据源从 `MOCK_AGENTS` 改为 `agents`
   - Agent 对象字段：`{ id, name, accentColor, expertise }`

2. **消息列表（第 193-224 行区域）**
   - 数据源从本地 `messages` 状态改为 hook 返回的 `messages`
   - 消息结构：`{ id, role, rawContent, agentId, createdAt }`
   - 新增流式响应显示：`{streaming[selectedAgent?.name] && <div>...</div>}`

3. **权限确认条（新增，参考 chat-area.tsx 第 213-234 行）**
   ```tsx
   {pendingPermissions.length > 0 && pendingPermissions.map(p => (
     <div key={p.requestId} className="border-t px-3 py-2 text-sm bg-amber-50 text-amber-800 flex items-center justify-between">
       <span className="flex items-center gap-1">
         <Shield className="w-4 h-4" />
         Agent 请求使用 <strong>{p.toolName}</strong>
         {p.toolName === 'Bash' && p.toolInput?.command && (
           <code className="ml-1 text-xs bg-amber-100 px-1 rounded">
             {String(p.toolInput.command).slice(0, 80)}
           </code>
         )}
         {p.toolName === 'Write' && p.toolInput?.file_path && (
           <code className="ml-1 text-xs bg-amber-100 px-1 rounded">
             {String(p.toolInput.file_path)}
           </code>
         )}
       </span>
       <div className="flex gap-2">
         <Button size="xs" variant="destructive" onClick={() => respondPermission(p.requestId, 'deny')}>拒绝</Button>
         <Button size="xs" onClick={() => respondPermission(p.requestId, 'allow')}>允许</Button>
       </div>
     </div>
   ))}
   ```

4. **项目目录选择（可选，新增）**
   - 在 Header 或设置区添加项目目录选择器
   - 数据源：`/api/recent-dirs`
   - 切换目录后更新 `projectDir` 并重新创建 Session

### 3. 微调 `src/app/api/sessions/route.ts`

**问题：** 当前私聊创建时（第 62-65 行）直接返回，不处理 `projectDir`。

**修改：** 第 62-65 行改为：

```typescript
// Private sessions: save projectDir but don't auto-add agents
if (type === 'private') {
  // projectDir 已在第 43 行保存，无需额外处理
  return NextResponse.json(session)
}
```

**实际上无需改动**——第 43 行已经保存了 `projectDir`。只需确保前端创建私聊时传入 `projectDir` 参数即可。

---

## 后端已支持的功能（无需改动）

| 功能 | 位置 | 说明 |
|------|------|------|
| 私聊 Session 类型 | `prisma/schema.prisma` | `Session.type = "private"` |
| 私聊消息路由 | `chat/route.ts` 第 254-271 行 | 直接调用 `executeSingleAgent` |
| 项目目录传入 | `chat/route.ts` 第 107-110 行 | `workDir = session.projectDir || process.cwd()` |
| 权限确认事件 | `use-chat.ts` 第 145-153 行 | SSE `permission_request` 事件 |
| 权限响应 API | `sessions/[id]/permission/route.ts` | POST 处理 allow/deny |

---

## 实现步骤

1. **创建 `use-chat-fab.ts` hook**
   - 复用 `useChat` 的 SSE 处理逻辑
   - 添加 Agent 列表获取、Session 创建/恢复逻辑

2. **重写 `chat-fab.tsx`**
   - 删除 Mock 数据和逻辑
   - 接入 `useChatFab` hook
   - 添加权限确认 UI
   - 添加流式响应显示

3. **测试验证**
   - 选择 Agent → 创建私聊 Session
   - 发送消息 → SSE 流式响应
   - Agent 执行 Bash/Write → 权限确认弹窗
   - 关闭再打开 → 历史消息保留

---

## 注意事项

1. **Session 复用策略**
   - 每个 Agent + 项目目录 组合对应一个私聊 Session
   - 可用 `localStorage` 缓存 `agentId -> sessionId` 映射，避免重复创建

2. **项目目录**
   - 默认使用最近使用的目录（`/api/recent-dirs` 第一条）
   - 用户可在 UI 中切换

3. **错误处理**
   - Agent 列表加载失败：显示错误提示
   - Session 创建失败：显示错误提示
   - SSE 连接断开：显示重连按钮

4. **性能优化**
   - Agent 列表可缓存（不频繁变化）
   - 历史消息懒加载（打开时才加载）

---

## 参考文件

- `src/components/chat-area.tsx`：完整的聊天 UI 实现，可参考消息渲染、权限确认条
- `src/lib/hooks/use-chat.ts`：SSE 处理逻辑，直接复用
- `src/app/chat/page.tsx`：私聊创建流程参考（第 39-46 行）
- `src/components/create-group-dialog.tsx`：项目目录选择器参考

# 工作区与权限模式设计

> 创建时间: 2026-05-22 | 最后更新: 2026-05-29 | 状态: 已完成

---

## 一、项目目录

### 已确定

- **输入方式**：用户手动输入路径
- **快捷选项**：显示最近打开的目录
- **Agent 工作方式**：所有 Agent 直接在 `projectDir` 中工作，不创建独立子目录
- **变更检测**：每批任务执行后 `git diff --name-only HEAD` 检测实际改动文件，对比 `declaredFiles` 越界修改发送告警

### 最近打开的目录

- **存储方式**：单独表（RecentDirs 表）
- **优点**：结构清晰，查询高效
- **数据模型**：

```prisma
model RecentDir {
  id        String   @id @default(uuid())
  path      String   @unique          // 目录路径
  lastUsed  DateTime @default(now())  // 最后使用时间
  useCount  Int      @default(1)      // 使用次数
}
```

---

## 二、权限模式

### 已确定

- **两种模式**：
  - `default` — 需要用户确认每次操作
  - `auto` — 自动处理，减少打扰
- **默认值**：`default`
- **选择时机**：创建群聊时让用户选择
- **允许修改**：创建后可以修改
- **私聊**：不需要配置，自动弹出权限确认
- **修改方式**：聊天命令 `/permission auto` 或 `/permission default`
- **UX 优化**：输入 `/` 后显示可用命令气泡列表，降低记忆负担
- **命令列表**：仅 `/permission` 一个命令（其他功能用 UI 按钮实现）

### Claude Code CLI 参数

```bash
claude --permission-mode <mode> --permission-prompt-tool stdio --output-format stream-json --verbose --bare
```

### 权限交互协议（default 模式）

`default` 模式下，CLI 通过 stdin/stdout 的 `control_request`/`control_response` 协议与前端交互：

**数据流**：
1. CLI 需要工具权限 → stdout 输出 `control_request` 事件
2. ProcessRegistry 解析 → SSE 转发 `permission_request` 到前端
3. 前端显示权限确认横幅（工具名 + 参数预览 + 允许/拒绝按钮）
4. 用户操作 → POST `/api/sessions/{id}/permission` → ProcessRegistry 写 `control_response` 到 CLI stdin
5. CLI 收到回应后继续执行或停止该工具调用

**事件格式**：

```json
// CLI → 前端（权限请求）
{ "type": "control_request", "request_id": "req-1",
  "request": { "subtype": "can_use_tool", "tool_name": "Bash", "input": { "command": "npm test" } } }

// 前端 → CLI（允许）
{ "type": "control_response", "response": { "subtype": "success", "request_id": "req-1",
  "response": { "behavior": "allow", "updatedInput": { "command": "npm test" } } } }

// 前端 → CLI（拒绝）
{ "type": "control_response", "response": { "subtype": "success", "request_id": "req-1",
  "response": { "behavior": "deny", "message": "User denied this tool use." } } }

// CLI → 前端（取消请求）
{ "type": "control_cancel_request", "request_id": "req-1" }
```

**关键约束**：
- `auto` 模式下 CLI 不发 `control_request`，权限横幅不会出现
- LLM/OpenCode Adapter 不走 ProcessRegistry，不受影响
- ProcessRegistry key 格式：`${sessionId}:${agentId}:${workDir}`，permission API 必须用相同格式

---

## 三、数据模型变更

### Session 表新增字段

```prisma
model Session {
  // ... 现有字段
  projectDir     String    @default("")       // 用户指定的项目目录
  permissionMode String    @default("default") // "default" | "auto"
}
```

### 新增 RecentDir 表

```prisma
model RecentDir {
  id        String   @id @default(uuid())
  path      String   @unique          // 目录路径
  lastUsed  DateTime @default(now())  // 最后使用时间
  useCount  Int      @default(1)      // 使用次数
}
```

---

## 四、实现步骤

1. Session 表添加 `projectDir` 和 `permissionMode` 字段
2. 新增 RecentDir 表
3. CreateGroupDialog 添加目录输入和权限模式选择
4. 创建会话 API 保存这两个字段
5. ClaudeCodeAdapter 使用 `--permission-mode` 参数
6. ClaudeCodeAdapter 使用 `projectDir` 作为工作目录（Agent 直接修改原项目文件）
7. 实现 `/permission` 聊天命令（含 `/` 气泡提示）
8. 实现最近打开目录的存储和显示
9. Git diff 变更检测：每批任务执行后检测越界修改

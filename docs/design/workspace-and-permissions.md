# 工作区与权限模式设计

> 创建时间: 2026-05-22 | 最后更新: 2026-10-20 | 状态: 已完成（双维度权限，2026-10-20 修订）

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
  - `default` — 需要用户确认每次操作（OpenCode headless 无法确认，见下）
  - `auto` — 自动处理，减少打扰
- **双维度**（2026-10-20 修订）：
  - **可用工具**：Agent.tools → Claude `--tools` / OpenCode agent frontmatter `tools`；
    未列出的工具不可用（不是“允许但会提示”）。
  - **审批**：Session.permissionMode → Claude `--permission-mode default` + ProcessRegistry
    的 auto 分支 / OpenCode agent frontmatter `permission` + `--auto`。
  - 不要把 `--allowedTools` 当可用性白名单：Claude 里它只表示“免审批”；真正可用性用 `--tools`。
- **默认值**：`default`
- **选择时机**：创建群聊时让用户选择
- **允许修改**：创建后可以修改
- **私聊**：不需要配置，自动弹出权限确认
- **修改方式**：聊天命令 `/permission auto` 或 `/permission default`
- **UX 优化**：输入 `/` 后显示可用命令气泡列表，降低记忆负担
- **命令列表**：仅 `/permission` 一个命令（其他功能用 UI 按钮实现）

### Claude Code CLI 参数（v2.1.270 实测，2026-10-20）

```bash
claude -p --output-format stream-json --input-format stream-json --verbose \
  --permission-prompt-tool stdio \
  --settings <managed>/settings.json \
  --setting-sources user \
  --permission-mode default \
  --tools <agent.tools 或 "default">
```

- **不再使用 `--bare`**：实测 `--bare` 只暴露 `Bash/Edit/Read`，且忽略 `--tools`；
- `CLAUDE_CONFIG_DIR` 负责隔离 transcript/插件 + `--settings` 投递 provider 配置；
- `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` 关闭 workDir 的 CLAUDE.md 自动发现；
- `auto` 模式额外传 `--allowedTools <agent.tools>`，ProcessRegistry 对剩余
  control_request 统一 allow；`default` 模式不传 `--allowedTools`，每次工具调用走前端确认；
- `--permission-mode auto` 在 `-p` + stdio 下**不发 control_request**（实测 AbortError），
  CLI 始终使用 `default`。

### OpenCode 权限（v2.0.27 实测，2026-10-20）

- `OPENCODE_CONFIG` / `OPENCODE_PERMISSION` **不生效**，已删除；
- 权限写入 `.opencode/agents/agenthub-<agentId>-<scope>.md` frontmatter；scope 含 chatSessionId、permissionMode、tools/model/baseUrl/workDir/mcpConfig 指纹与 adapter 实例 nonce，避免 default/auto 或并发任务互相覆盖：
  - `tools`：可用性（true/false）
  - `permission`：`ask | allow | deny`（`bash` 映射为 OpenCode `shell` 规则）
  - `read` 用对象规则保留 `.env` ask（`*` allow 不会覆盖敏感文件默认审批）
- `auto` 模式传 `--auto`（自动批准 ask、仍尊重 deny）；`default` 不传；
- **headless `opencode run` 没有 TTY 确认协议**：`ask` 会被自动拒绝。因此 OpenCode
  的 `default` 实际是只读（read/glob/grep/list/todowrite allow，写/执行/联网 ask）；
  需要写操作请切 `auto`。UI 已提示该限制。
- `Bash` 同时授予 OpenCode `bash` 与 `execute`，避免 v2 provider 只暴露 execute 时能力丢失。

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
- Claude CLI 始终以 `default` 模式启动；`auto` 模式下 ProcessRegistry 收到 `control_request`
  后直接写 allow（权限横幅不出现），`default` 模式转发前端
- OpenCode 不走 Claude 的 control_request 协议；权限由 agent frontmatter + `--auto` 控制
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
5. ClaudeCodeAdapter 使用 `--settings` + `--tools` + `--permission-mode default`；OpenCode 用 agent frontmatter `tools`/`permission`
6. Agent 使用 `projectDir` 作为工作目录（Agent 直接修改原项目文件）
7. 实现 `/permission` 聊天命令（含 `/` 气泡提示）
8. 实现最近打开目录的存储和显示
9. Git diff 变更检测：每批任务执行后检测越界修改

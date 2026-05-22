# 工作区与权限模式设计

> 创建时间: 2026-05-22 | 状态: 已完成

---

## 一、项目目录

### 已确定

- **输入方式**：用户手动输入路径
- **快捷选项**：显示最近打开的目录
- **目录不存在**：自动创建（递归创建，`mkdirSync(path, { recursive: true })`）
- **Agent 独立目录**：在根目录下为每个 Agent 创建子目录

### 目录结构示例

```
E:\projects\todo-app\          ← 根目录（用户输入）
    ├── frontend\              ← 前端工程师
    ├── backend\               ← 后端工程师
    └── tests\                 ← 测试工程师
```

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

### Agent 子目录

- **命名规则**：英文标识（如 `frontend/`、`backend/`）
- **创建方式**：自动创建
- **共享文件**：不需要额外机制，Agent 通过 Orchestrator 协调和 context 传递信息
- **目录验证**：不做额外验证，创建目录时直接处理（失败则抛出错误）

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
claude --permission-mode <mode> --output-format stream-json --verbose --bare
```

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
6. ClaudeCodeAdapter 使用 `projectDir` 作为工作目录
7. 实现 `/permission` 聊天命令（含 `/` 气泡提示）
8. 实现最近打开目录的存储和显示

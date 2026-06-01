# Skill 功能实现计划

> 创建时间: 2026-05-31 | 状态: **已评估不实施**（2026-06-01）
>
> **砍除原因**：1) AgentSkill 多对多关联在磁盘共享机制下是伪概念；2) 执行时写入多余，CRUD 时写一次即可；3) CC Switch 已有完善 Skill 管理，功能重叠；4) 不在 AgentHub 核心价值链（编排协作）上。

## Context

AgentHub 的 `/skills` 页面只有 UI 壳子（mock 数据），无数据库表、无 API、无执行集成。需要参照 multica 实现完整的 Skill 系统：数据管理 → 本地导入 → Agent 分配 → 执行时写入文件让 CLI 原生发现。

**核心机制**：Skill 内容写到 CLI 的全局 skill 目录，CLI 原生发现加载，不需要拼接到 systemPrompt。

| platform | skill 写入路径 |
|----------|---------------|
| `claude-code` | `~/.claude/skills/{name}/SKILL.md` |
| `opencode` | `~/.claude/skills/{name}/SKILL.md` （同一个目录，OpenCode 也从这里发现） |

> 验证方式：`opencode debug skill` 输出所有 skill 的 location 都在 `~/.claude/skills/`

**不支持的平台**：LLMAdapter 已弃用，不处理。

## 参考项目

- **multica** (`D:\ai全栈挑战赛\multica`) — Skill 表 + SkillFile + AgentSkill 关联，URL 导入 + 本地扫描，写到 provider-native 发现路径
- **cc-connect** (`D:\ai全栈挑战赛\cc-connect`) — SkillRegistry 递归扫描 SKILL.md，skill-presets.json 远程预设

## 关键发现

1. Claude Code 和 OpenCode 共享 `~/.claude/skills/` 目录，不需要按平台区分路径
2. Skill = SKILL.md 文件（YAML frontmatter + Markdown body），纯文本指令，不定义工具/权限
3. 执行时写文件到全局目录，CLI 原生发现，不需要修改 systemPrompt
4. 本地已有 54 个 skill 可导入（`~/.claude/skills/`）

## 文件清单

### 新增

| 文件 | 说明 |
|------|------|
| `src/lib/skill-parser.ts` | SKILL.md frontmatter 解析 + 递归目录扫描（最多 4 层） |
| `src/lib/skill-writer.ts` | 写 skill 文件到 `~/.claude/skills/` |
| `src/app/api/skills/route.ts` | GET 列表 + POST 创建 |
| `src/app/api/skills/[id]/route.ts` | GET/PUT/DELETE 单个 |
| `src/app/api/skills/import/route.ts` | POST 扫描本地目录 + 导入 |
| `src/app/api/agents/[id]/skills/route.ts` | GET/PUT Agent-Skill 关联 |
| `tests/skill-parser.test.ts` | 解析器单元测试 |
| `tests/skill-writer.test.ts` | 写入逻辑单元测试 |

### 修改

| 文件 | 改动 |
|------|------|
| `prisma/schema.prisma` | 加 Skill + AgentSkill 模型，Agent 加反向关联 |
| `src/lib/orchestrator/index.ts` | executeSingleAgent + executeTaskBatch 执行前调用 writeAgentSkills |
| `src/app/(dashboard)/skills/page.tsx` | mock → 真实 API，数据表 + 筛选 + 搜索 |
| `src/app/(dashboard)/skills/[id]/page.tsx` | mock → 真实 API，编辑/删除/关联 Agent |
| `src/app/(dashboard)/page.tsx` | dashboard skill count 真实化 |
| `src/components/create-agent-dialog.tsx` | 加 Skill 多选分配 |
| `src/app/(dashboard)/agents/[id]/page.tsx` | Agent 详情页加 Skill 管理 |

## 详细设计

### 1. Prisma Schema

```prisma
model Skill {
  id          String   @id @default(uuid())
  name        String   @unique
  description String   @default("")
  content     String                    // SKILL.md body（不含 frontmatter）
  sourcePath  String   @default("")     // 导入来源路径，如 ~/.claude/skills/browse/SKILL.md
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  agentSkills AgentSkill[]
}

model AgentSkill {
  id        String   @id @default(uuid())
  agentId   String
  skillId   String
  createdAt DateTime @default(now())
  agent Agent @relation(fields: [agentId], references: [id], onDelete: Cascade)
  skill Skill @relation(fields: [skillId], references: [id], onDelete: Cascade)
  @@unique([agentId, skillId])
}

// Agent 模型加：
agentSkills AgentSkill[]
```

### 2. Skill Parser (`src/lib/skill-parser.ts`)

- `parseSkillFile(content: string)` — 解析 `---` frontmatter，提取 name/description/body
- `scanSkillDirectory(dirPath: string)` — **递归扫描**（最多 4 层）找 SKILL.md
- 不引入 gray-matter，正则解析
- 处理：引号包裹值、多行 `|` 描述、缺 name 时 fallback 目录名

### 3. Skill Writer (`src/lib/skill-writer.ts`)

```typescript
export async function writeSkillToDisk(
  skill: { name: string; description: string; content: string }
): Promise<void>
```

- 统一写到 `~/.claude/skills/{name}/SKILL.md`（Claude Code 和 OpenCode 共享）
- 自动创建目录
- 写入时包含 frontmatter（name + description）

```typescript
export async function removeSkillFromDisk(skillName: string): Promise<void>
```

- 删除 `~/.claude/skills/{skillName}/` 目录

```typescript
export async function writeAgentSkills(agentId: string): Promise<void>
```

- 查询 Agent 的所有 skill
- 调用 writeSkillToDisk 写入每个 skill

### 4. API Routes

**GET /api/skills** — 列表，含 `_count.agentSkills`，orderBy name asc
**POST /api/skills** — 创建 skill + 自动写入全局目录
**GET /api/skills/[id]** — 详情，含 agentSkills.agent
**PUT /api/skills/[id]** — 更新 + 重新写入全局目录
**DELETE /api/skills/[id]** — 删除 + 删除全局目录文件（级联删 AgentSkill）
**POST /api/skills/import** — 扫描本地目录导入：
  - 新 skill：创建 + 写入全局目录
  - 已存在且 sourcePath 匹配：更新（来源一致说明是重新导入）
  - 已存在但 sourcePath 不同或为空：**跳过**（用户手动创建的不覆盖）
**GET /api/agents/[id]/skills** — Agent 关联的 skills
**PUT /api/agents/[id]/skills** — `{ skillIds: [] }` 替换关联 + 重新写入全局目录

### 5. 执行集成 (`src/lib/orchestrator/index.ts`)

在 `executeSingleAgent` 和 `executeTaskBatch` 的 adapter.send() 之前，调用 `writeAgentSkills(agentId)` 确保 skill 文件已写入 `~/.claude/skills/`。

**不需要修改 systemPrompt**——CLI 原生发现 skill 文件。

插入点：
- `executeSingleAgent` 约 342 行（adapter 创建后，send 前）
- `executeTaskBatch` 约 261 行（同上）

### 6. UI 改造

**Skills 列表页** (`skills/page.tsx`)：
- 升级为数据表（Name / Used by / Source / Updated 列）
- 搜索 + 筛选（All / In use / Unused）
- "导入本地 Skills" 按钮 + "创建 Skill" 按钮

**Skill 详情页** (`skills/[id]/page.tsx`)：
- 编辑 name/description/content
- 删除按钮
- 右侧栏显示关联的 Agent 列表

**Dashboard** (`page.tsx`)：
- 177 行 `"-"` → 真实 skillCount

**Agent 对话框** (`create-agent-dialog.tsx`)：
- 加 Skill 多选 checkbox

**Agent 详情页** (`agents/[id]/page.tsx`)：
- 加 Skill 管理入口（添加/移除）

### 7. Token 安全

- 只写文件到全局目录，不拼 systemPrompt，不存在 token 膨胀问题
- 单个 SKILL.md 文件大小由 CLI 自己控制发现

## 实现顺序

1. Prisma schema → migrate + generate
2. skill-parser.ts + 测试
3. skill-writer.ts + 测试
4. API routes（CRUD + import + agent-skill）
5. orchestrator/index.ts 集成（writeAgentSkills 调用）
6. UI 改造（列表/详情/dashboard/Agent 对话框/Agent 详情）
7. 全量测试 `npx vitest run`
8. 文档更新（PROGRESS.md + CLAUDE.md）

## 验证方案

1. `npx prisma migrate dev` — Skill + AgentSkill 表创建成功
2. `POST /api/skills/import` — 导入 ~/.claude/skills/ 的 54 个 skills
3. `GET /api/skills` — 返回列表
4. Agent 分配 skill → `GET /api/agents/{id}/skills` 验证
5. 发消息触发执行 → 检查 `~/.claude/skills/` 目录下有对应 SKILL.md 文件
6. `opencode debug skill` 验证新写入的 skill 出现在列表中
7. Dashboard skill count 显示真实数字
8. `npx vitest run` — 全量通过

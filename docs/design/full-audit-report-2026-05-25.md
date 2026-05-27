# AgentHub 全量代码审查报告 (2026-05-25)

> 4个专业Agent并行审查：后端、前端、安全/架构、设计一致性

## 总览

| 维度 | P0 | P1 | P2 | P3 | 合计 |
|------|-----|-----|-----|-----|------|
| 后端 | 8 | 16 | 18 | 8 | 50 |
| 前端 | 4 | 11 | 7 | - | 22 |
| 安全/架构 | 5 | 8 | 9 | 4 | 26 |
| 设计一致性 | 1 | 5 | 5 | - | 11 |
| **合计** | **18** | **40** | **39** | **12** | **109** |

---

## P0 问题清单（18项，必须修复）

### 安全类

| # | 问题 | 文件 | 描述 |
|---|------|------|------|
| P0-1 | API Key 明文泄露(agents list) | agents/route.ts:9-13 | GET /api/agents 返回完整 apiKey |
| P0-2 | API Key 明文泄露(agent detail) | agents/[id]/route.ts:9-13 | GET/PUT 返回完整 apiKey |
| P0-3 | API Key 明文泄露(members) | sessions/[id]/members/route.ts:9-14 | include agent 暴露 apiKey |
| P0-4 | API Key 明文泄露(session detail) | sessions/[id]/route.ts:9-20 | 嵌套 include 暴露 apiKey |
| P0-5 | API Key 明文泄露(providers) | providers/route.ts + providers/import/route.ts | CC-Switch配置含完整apiKey返回前端 |
| P0-6 | Provider Import 同步文件IO读凭证 | providers/import/route.ts:2-3,49-50,59 | readFileSync在API Route中读取home目录配置 |
| P0-7 | Session PUT 任意字段写入 | sessions/[id]/route.ts:28-34 | body直接传入prisma.update，Mass Assignment |
| P0-8 | Files Accept 路径穿越防护不完整 | files/accept/route.ts:19-37 | 仅检查`..`，无符号链接检查，project模式可写任意文件 |
| P0-9 | iframe srcdoc XSS | web-preview.tsx:34-38 | LLM输出HTML直接注入iframe，sandbox="allow-scripts"仍可执行JS |
| P0-10 | CLI 命令注入(shell:true) | claude-code-adapter.ts:40-56 + opencode-adapter.ts:53-58 | shell:true + 用户可控permissionMode |
| P0-11 | API Key 明文存储在数据库 | prisma/schema.prisma:38 | Agent.apiKey 明文存SQLite |
| P0-12 | SSE JSON.parse无保护 | use-chat.ts:79 | 格式错误SSE数据导致前端崩溃 |
| P0-13 | Agent PUT 任意字段更新 | agents/[id]/route.ts:30-46 | 无白名单过滤，可修改isPreset等 |
| P0-14 | Session PUT 任意字段(前端视角) | sessions/[id]/route.ts:29-33 | 前端确认的同一问题 |
| P0-15 | Provider API Key明文暴露(前端视角) | providers/route.ts:43-84 | 前端可通过Network标签截获完整Key |
| P0-16 | Files Accept 写入项目根目录 | files/accept/route.ts | target=project时baseDir=process.cwd()，可写src/目录 |
| P0-17 | CLI进程泄漏-无全局注册表 | claude-code-adapter.ts:9-11 + opencode-adapter.ts:9 | 无ProcessRegistry追踪孤儿进程 |
| P0-18 | Claude Code长驻进程模式未实现 | claude-code-adapter.ts:24-111 | 每次调用spawn新进程而非stdin/stdout管道长驻模式 |

### 去重后实际独立P0问题（12项）

1. **API Key 明文泄露**（覆盖P0-1~5, P0-11, P0-15）— 6个API端点返回完整apiKey
2. **Session/Agent PUT 任意字段**（覆盖P0-7, P0-13, P0-14）— Mass Assignment漏洞
3. **Files Accept 路径穿越+任意写入**（覆盖P0-8, P0-16）— project模式可写项目源码
4. **iframe XSS**（覆盖P0-9）— LLM输出可执行任意JS
5. **CLI 命令注入**（覆盖P0-10）— shell:true
6. **SSE JSON.parse崩溃**（覆盖P0-12）— 格式错误中断消息流
7. **CLI进程泄漏**（覆盖P0-17）— 无全局进程注册表
8. **Claude Code长驻进程缺失**（覆盖P0-18）— 设计偏差
9. **Provider Import同步IO读凭证**（覆盖P0-6）— 阻塞事件循环
10. **API Key 明文存储DB**（覆盖P0-11）— SQLite无加密

---

## P1 问题清单（40项，应该修复）

### 后端（16项）

| # | 问题 | 文件 |
|---|------|------|
| P1-1 | sessionLocks内存泄漏 | chat/route.ts:9 |
| P1-2 | Chat Route未验证message必填 | chat/route.ts:47 |
| P1-3 | request.json()无try-catch(chat) | chat/route.ts:47 |
| P1-4 | 多API Route request.json()无保护 | agents/route.ts等6处 |
| P1-5 | Agent POST缺少类型校验 | agents/route.ts:16-25 |
| P1-6 | Agent PUT status值无枚举校验 | agents/[id]/route.ts:28-46 |
| P1-7 | executeTaskBatch依赖上下文竞态 | orchestrator/index.ts:183-237 |
| P1-8 | handleExecution while循环无全局上限 | chat/route.ts:578-723 |
| P1-9 | ClaudeCodeAdapter进程泄漏(双定时器) | claude-code-adapter.ts:68-77 |
| P1-10 | ClaudeCodeAdapter close()误删目录 | claude-code-adapter.ts:182-187 |
| P1-11 | OpenCodeAdapter硬编码全权限 | opencode-adapter.ts:43 |
| P1-12 | callLLM/callLLMForAnalysis异常吞没 | orchestrator/index.ts:13-37 |
| P1-13 | recommend-agents JSON无校验 | recommend-agents/route.ts:42-45 |
| P1-14 | parseJSON括号匹配不处理嵌套 | orchestrator/index.ts:84-105 |
| P1-15 | Session创建同步IO | sessions/route.ts:3,59-71 |
| P1-16 | workspace.ts全同步IO | workspace.ts |

### 前端（11项）

| # | 问题 | 文件 |
|---|------|------|
| P1-17 | use-chat SSE内存泄漏 | use-chat.ts:55-132 |
| P1-18 | useSessions竞态条件 | use-sessions.ts:36-39 |
| P1-19 | ChatArea全量重渲染 | chat-area.tsx:103-155 |
| P1-20 | SSE未处理event字段和多行data | use-chat.ts:73-77 |
| P1-21 | API Key泄露到前端(Provider) | providers/route.ts:43-84 |
| P1-22 | Files Accept写入保护不足 | files/accept/route.ts |
| P1-23 | 类型重复定义(Message/Agent/Session) | use-chat.ts, agent-panel.tsx等 |
| P1-24 | SSEEvent类型不完整 | use-chat.ts:14-19 |
| P1-25 | layout metadata默认模板 | layout.tsx:4-6 |
| P1-26 | 三栏布局响应式缺失 | chat-area.tsx + sidebar + panel |
| P1-27 | Error Boundary缺失 | 全前端 |

### 安全/架构（8项）

| # | 问题 | 文件 |
|---|------|------|
| P1-28 | 无认证机制 | 全API |
| P1-29 | projectDir未验证 | sessions/route.ts:15 + chat/route.ts:58-60 |
| P1-30 | SSE流无认证 | chat/route.ts:248-254 |
| P1-31 | SSE超时未清理CLI子进程 | chat/route.ts:129-131 |
| P1-32 | 工作区复制整个项目 | workspace.ts:15-30 |
| P1-33 | 无结构化日志 | 全项目 |
| P1-34 | AgentPanel轮询清理 | agent-panel.tsx:60-71 |
| P1-35 | parseJSON handleCreateAgent未传requiredKeys | chat/route.ts:481 |

### 设计一致性（5项）

| # | 问题 | 设计vs代码 |
|---|------|------|
| P1-36 | Orchestrator用claude-code而非llm | 设计:LLM API / 代码:首选claude-code |
| P1-37 | LLM Agent产出无独立工件存储 | 设计:工件存DB / 代码:只存Message.rawContent |
| P1-38 | 消息内容双重解析 | 设计:后端解析前端渲染 / 代码:前端也解析 |
| P1-39 | Diff Accept缺少用户修改检查 | 设计:检查用户手动修改 / 代码:直接写入 |
| P1-40 | 对话式创建缺确认环节+工具集未实现 | 设计:用户确认后创建 / 代码:直接创建 |

---

## P2 问题清单（39项）

### 后端（18项）

| # | 问题 | 文件 |
|---|------|------|
| P2-1 | Session DELETE无级联确认 | sessions/[id]/route.ts:39-43 |
| P2-2 | RecentDir DELETE通过body传ID | recent-dirs/route.ts:28-37 |
| P2-3 | Deploy API纯模拟 | deploy/route.ts:3-14 |
| P2-4 | orchestrator角色硬编码中文名 | sessions/route.ts:51,81 |
| P2-5 | handleExecution未被直接调用 | chat/route.ts:520-742 |
| P2-6 | tasks数组就地修改 | chat/route.ts:580-723 |
| P2-7 | Agent创建tools默认值不一致 | agents/route.ts vs chat/route.ts |
| P2-8 | LLMAdapter close()后不可复用 | llm-adapter.ts:61-63 |
| P2-9 | topologicalSort就地修改输入 | scheduler.ts:53-57 |
| P2-10 | enforceFileOverlap taskMap.get可能undefined | scheduler.ts:91 |
| P2-11 | Message.role无枚举约束 | schema.prisma:85 |
| P2-12 | Session type/phase/permissionMode无枚举 | schema.prisma:13-19 |
| P2-13 | createTaskWorkspace复制整个项目 | workspace.ts:15-31 |
| P2-14 | auditTaskWorkspace用mtime比较 | workspace.ts:106-128 |
| P2-15 | diffFileLists modified永远为空 | workspace.ts:70-86 |
| P2-16 | SSE超时controller.close()可能抛异常 | chat/route.ts:129-132 |
| P2-17 | Provider Import TOML解析简陋 | providers/import/route.ts:16-41 |
| P2-18 | use-chat SSE解析无错误处理 | use-chat.ts:79 |

### 前端（7项）

| # | 问题 | 文件 |
|---|------|------|
| P2-19 | copiedIdx timer未清理 | chat-area.tsx:236-240 |
| P2-20 | @mention只匹配第一个 | chat-area.tsx:74-84 |
| P2-21 | 多处缺ARIA属性 | chat-area.tsx, agent-panel.tsx, sidebar |
| P2-22 | sessionLocks Map永不清理 | chat/route.ts:9 |
| P2-23 | as any类型绕过 | chat/route.ts:694,697 |
| P2-24 | 中英文混用 | web-preview, code-diff, agent-panel, file-card |
| P2-25 | Dialog自定义实现非shadcn/ui | dialog.tsx |

### 安全/架构（9项）

| # | 问题 | 文件 |
|---|------|------|
| P2-26 | CORS未配置 | next.config.ts |
| P2-27 | 错误信息泄露内部路径 | claude-code-adapter.ts:104-105 |
| P2-28 | 无速率限制 | 全API |
| P2-29 | Artifact解析无消毒 | message-parser.ts:41-52 |
| P2-30 | 纠偏重试(task as any)类型不安全 | chat/route.ts:694-698 |
| P2-31 | parseJSON宽松解析 | orchestrator/index.ts:67-120 |
| P2-32 | SQLite并发写入瓶颈 | schema.prisma + db.ts |
| P2-33 | Agent创建LLM输出直接入库 | chat/route.ts:473-516 |
| P2-34 | 任务轮询硬编码3秒 | agent-panel.tsx:65-70 |

### 设计一致性（5项）

| # | 问题 | 设计vs代码 |
|---|------|------|
| P2-35 | 任务完成后工件被清理 | 设计:关机不丢失 / 代码:cleanupTaskWorkspaces删除 |
| P2-36 | 合并审计用mtime非git diff | 设计:git diff / 代码:mtime比较 |
| P2-37 | Agent平台标识未展示 | 设计:面板+初始消息展示 / 代码:无 |
| P2-38 | 消息气泡左侧色条未实现 | 设计:accentColor色条 / 代码:无色条 |
| P2-39 | docs/ai-collaboration.md未创建 | 设计:Skill层 / 代码:不存在 |

---

## P3 问题清单（12项）

| # | 问题 | 文件 |
|---|------|------|
| P3-1 | Agent POST P2002错误处理不完整 | agents/route.ts:42-47 |
| P3-2 | hashName可能产生负数 | agent-colors.ts:13-17 |
| P3-3 | hexToHsl无校验 | agent-colors.ts:20-35 |
| P3-4 | parseMessage lineOffset不准确 | message-parser.ts:27-37 |
| P3-5 | ClaudeCodeAdapter stderr未利用 | claude-code-adapter.ts:60-65 |
| P3-6 | OpenCodeAdapter无noOutputTimer | opencode-adapter.ts |
| P3-7 | seed.ts无事务包裹 | seed.ts:66-79 |
| P3-8 | db.ts Prisma单例Edge失效 | db.ts:4-15 |
| P3-9 | dev.db提交风险 | .gitignore |
| P3-10 | 缺安全响应头 | next.config.ts |
| P3-11 | deploy端点空壳 | deploy/route.ts:3-14 |
| P3-12 | Provider Import端点无实际写入 | providers/import/route.ts:4-26 |

---

## 已修复的Bug（上轮审查，本轮仍需验证）

| Bug | 修复内容 | 验证状态 |
|-----|---------|---------|
| #1 | 消息排序(take+orderBy) | 通过 |
| #2 | Promise.allSettled+failedTaskIds | 通过(有依赖竞态新问题) |
| #3 | runDiscussion try-catch隔离 | 通过 |
| #4 | 纠偏重试机制 | 通过(但while无全局上限) |
| #5 | findLastIndex→reduce | 通过 |
| #6 | permissionMode两处修复 | 通过 |
| #7 | parseJSON requiredKeys(4/5通过,1遗漏) | 部分通过 |
| #8 | PM确认+callLLMForAnalysis try-catch | 通过 |
| #9 | handleArchitectPlan空任务早返回 | 通过 |
| #10 | executeSingleAgent LLM fallback | 通过 |

---

## 最高优先修复建议（Top 5）

1. **API Key泄露** — 6个端点返回完整apiKey，需统一剥离或脱敏
2. **Mass Assignment** — Session/Agent PUT需字段白名单
3. **iframe XSS** — 加DOMPurify消毒或去掉allow-scripts
4. **SSE JSON.parse** — 加try-catch避免前端崩溃
5. **executeTaskBatch依赖竞态** — 按batch串行执行而非全并行
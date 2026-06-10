# AgentHub 项目进度
> 创建时间: 2026-05-22 | 最后更新: 2026-06-10

## 项目概述
**项目地址**: D:\ai全栈挑战赛\agenthub | **技术选型**: Next.js 16 + Prisma 7 + SQLite + Claude Code CLI + OpenCode CLI | **目标**: IM 风格多 Agent 协作平台

## 当前进度

### ✅ 已完成
| 阶段 | 内容 | 完成日期 |
|------|------|----------|
| 基础框架 | Next.js 16 + Prisma 7 + SQLite + shadcn/ui | 2026-05-22 |
| 数据模型 v2 | Session/Agent/Task/Message/RecentDir | 2026-05-23 |
| Orchestrator 编排 | 8种 action + 安全校验 + 决策函数 | 2026-05-24 |
| CLI 适配器 | ClaudeCodeAdapter（stdin + bare + stream-json） | 2026-05-25 |
| 群聊 + 私聊 | 多会话类型 + Agent 成员管理 | 2026-05-25 |
| 全量审计 | 109项问题修复 | 2026-05-25 |
| 安全审计 | 9项修复 + API Key 双重掩码 | 2026-05-26 |
| 多供应商 | Agent 级 platform/model/baseUrl/apiKey | 2026-05-27 |
| QA 全流程 | 嵌套路由404 + 编码乱码 + mock 修复 | 2026-05-28 |
| 对齐流程 | PM确认+架构师方案+Agent提问 完整实现 | 2026-05-28 |
| 长驻进程 | ProcessRegistry 进程池复用+10分钟空闲回收 | 2026-05-29 |
| Agent状态同步 | idle→working→idle 生命周期+前端状态圆点 | 2026-05-29 |
| 6项代码修复 | 进程误杀+外键+并发权限+路径遍历+SSE错误+role对齐 | 2026-05-29 |
| ChatFab 私聊规划 | 计划文件+实现方案 | 2026-05-29 |
| CLI 进程恢复重试 | ProcessRegistry.send() 崩溃检测+自动重试+60s超时兜底 | 2026-05-30 |
| 单Agent纠偏审查 | delegate/@提及/私聊/discuss 4路径+reviewResult+quality标记 | 2026-05-30 |
| 任务重做功能 | failed/blocked任务重做+编辑描述+级联执行下游任务 | 2026-05-30 |
| 错误分类与指数退避 | 永久错误不重试+瞬时错误指数退避1s→2s→4s+重试3次 | 2026-05-30 |
| 纠偏计数器持久化 | Task.correctionCount字段+重启不丢失 | 2026-05-30 |
| ProcessRegistry优雅关闭 | SIGTERM→5s→SIGKILL+信号处理注册 | 2026-05-30 |
| Agent状态Per-Session | SessionMember.status替代Agent.status+独立会话状态 | 2026-05-30 |
| God Function拆分 | chat/route.ts 1102行→191行+7个service模块 | 2026-05-30 |
| ChatFab 私聊功能 | Mock→真实API：useChatFab hook + sessions members include | 2026-05-31 |
| Pin 消息 | Message.isPinned + API + 上下文优先 + 前端标记 | 2026-05-31 |
| 测试质量修复 | 6个虚假测试重写：database/prompts/recommend-agents/adapter/alignment/garbled-text，216→233测试 | 2026-05-31 |
| 多供应商隔离测试 | LLMAdapter独立性+baseUrl归一化+ProcessRegistry per-agent env隔离+OpenCode env注入，11测试 | 2026-05-31 |
| CC-Switch导入测试 | TOML解析+去重+apiKey掩码+providers/import端点+config/import-provider端点，24测试 | 2026-05-31 |
| 主流程测试覆盖 | execution-flow.test.ts(14用例)+review.test.ts(3用例)：对齐流程/执行循环/越界检测/纠偏重试/blocked状态，233→297测试 | 2026-06-01 |
| 全模块测试覆盖 | 13个新测试文件：API路由(25用例)+adapter(41用例)+services(42用例)+orchestrator(26用例)+app-config(6用例)，覆盖率33%→82%，297→437测试 | 2026-06-01 |
| ClaudeCode Provider 注入 | SpawnConfig 加 apiKey/baseUrl/model + spawnProcess 注入 ANTHROPIC_API_KEY/BASE_URL + --model CLI 参数 | 2026-05-31 |
| Provider 表 + UI | Provider 模型 + CRUD API + CreateProviderDialog + Agent 对话框下拉选择 + 种子数据 | 2026-05-31 |
| CC-Switch DB 集成 | cc-switch-reader.ts 读取 ~/.cc-switch/cc-switch.db + 4 源合并 + baseUrl 去重 | 2026-05-31 |
| 图片/文件附件 | Attachment 模型 + 上传/读取 API + AttachmentInput 组件 + 拖拽/粘贴 + ClaudeCodeAdapter image block + 中间层透传 + 文件清理，437测试 | 2026-06-01 |
| Skill 功能砍除 | 评估后移除：AgentSkill 关联在磁盘共享下是伪概念，CC Switch 已有方案 | 2026-06-01 |
| 适配器生命周期重构 | ProcessRegistry 直接复用：SpawnConfig 扩展 + readNdjsonRound + send 分发 + OpenCodeAdapter 委托，449测试 | 2026-06-02 |
| OpenCode适配器修复 | 3个bug：去掉不存在的run子命令、systemPrompt拼接到消息、错误消息提取路径event.error?.data?.message | 2026-06-02 |
| 测试覆盖率提升 | 3个新测试文件(process-registry-extended/claude-code-adapter-extended/attachment-cleanup)，覆盖率86%→91%，修复3个虚假测试，485测试 | 2026-06-02 |
| Regenerate验证修复 | chat API空消息验证未考虑regenerate场景，485测试 | 2026-06-02 |
| isPermanentError修复 | stderr捕获+alive检查+永久错误事件检测+send立即throw，isPermanentError路径从不可达变为完全可达，490测试 | 2026-06-02 |
| Provider导入多源解析 | 新建provider-resolve.ts统一4源解析，修复providers/import和config/import-provider只读TOML的bug，7新测试，497测试 | 2026-06-02 |
| 工具集硬限制 | Claude Code CLI参数(--allowedTools/--disallowedTools) + OpenCode临时配置文件(OPENCODE_CONFIG) + 工具名映射(edit覆盖write/apply_patch, Agent→task) + 进程key hash隔离 + OPENCODE_PERMISSION冲突处理，16新测试，553测试 | 2026-06-04 |
| BUG-003修复 | 群聊checkbox双重toggle：onChange+onClick冲突，stopPropagation阻止冒泡（ISSUE-待办讨论结果） | 2026-06-05 |
| 断点续跑 | GET session时自动重置in_progress任务为pending，返回recoveredTaskCount（ISSUE-待办讨论结果） | 2026-06-05 |
| RECOVER-001 | 任务恢复提示UI：加载会话时弹Dialog提示"上次有N个任务未完成，是否继续？" | 2026-06-05 |
| DIFF-001 | Accept前文件修改检测：md5对比，不一致返回409，前端弹确认框，8新测试 | 2026-06-05 |
| FAIL-007 | 全链路trace：Task表加trace字段，execution.ts各关键节点写trace，前端可展开查看，4新测试，583测试 | 2026-06-05 |
| 私聊创建成员修复 | route.ts private分支加agentIds处理 + use-sessions hook加agentIds参数 + UI一步操作 | 2026-06-04 |
| provider-resolve类型修复 | parseConfigTomlProviders返回类型缺name字段，新增TomlProvider接口 | 2026-06-04 |
| E2E端到端测试 | 16项功能验证：群聊/消息/@mention/Pin/归档/搜索/Agent CRUD/文件上传/权限/回复/Provider/配置API。发现5个Bug，修复1个 | 2026-06-04 |
| E2E深度测试(二次) | 117项检查全通过：会话CRUD(23)/Agent CRUD(18)/消息(7)/Pin(5)/成员(8)/Provider(5)/配置(5)/目录(5)/Chat(17)/其他(24)。发现2个新Bug：Pin存在性检查顺序(LLM适配器baseUrl误判) | 2026-06-04 |
| BUG-007修复 | Pin消息路由：消息存在性检查移到Pin数量限制检查之前，400→404 | 2026-06-04 |
| BUG-008修复 | LLM适配器：新增detectUseAnthropic()URL检测，/anthropic路径用Anthropic SDK，Anthropic分支支持自定义baseUrl。18新测试，571测试 | 2026-06-04 |
| BUG-009修复 | 进程注册表：无baseUrl时清除系统ANTHROPIC_BASE_URL，避免CLI用错误端点 | 2026-06-04 |
| BUG-010修复 | app-config：Orchestrator默认model改为空字符串，CLI用自身默认模型 | 2026-06-04 |
| 移除LLM平台 | 15个源码文件+12个测试+种子数据+Schema：类型移除'llm'、工厂移除LLMAdapter分支、所有fallback改'claude-code'、UI移除LLM选项、删除3个llm Agent。LLMAdapter代码保留备用。570测试通过 | 2026-06-04 |
| BUG-002修复确认 | Agent创建时apiKey已从Provider同步：applyProvider()同步到表单+handleSubmit提交+API持久化 | 2026-06-04 |
| BUG-004修复确认 | 中文标题编码：hasLoneSurrogates()校验+NextResponse.json自动charset=utf-8 | 2026-06-04 |
| BUG-005修复确认 | Pin消息：message-action-menu.tsx onClick={onPin}已正确实现，完整调用链已通 | 2026-06-04 |
| ISSUE-ORC-004确认 | 阶段切换已实现：8种action+phase/phaseStep字段+validateDecision()强制转换+alignment.ts显式推进 | 2026-06-04 |
| QA-16修复 | use-chat.ts网络异常catch块添加用户可见错误消息（之前只console.error） | 2026-06-05 |
| QA-18修复 | runDiscussion过滤error chunk不拼入讨论摘要，error仍通过onChunk转发SSE | 2026-06-05 |
| TOOL-002实现 | create-agent-dialog工具选择UI：9个工具分3组(文件/执行/网络)多选checkbox，默认全选，提交时传tools字段 | 2026-06-05 |
| UI-001实现 | 会话列表Agent头像拼图：sessions API返回agent name/accentColor，sidebar显示首字母圆圈(最多3个+剩余数) | 2026-06-05 |
| 模型名后缀清理 | process-registry.ts: 传递--model前正则去除[xxx]后缀（如mimo-v2.5[1m]→mimo-v2.5），防止API 400 | 2026-06-05 |
| QA视觉测试 | /browse截图+视觉AI分析：覆盖首页/创建群聊/Agent选择/聊天/Orchestrator响应/Tasks面板/Agent面板/服务商导入/响应式布局，发现7个问题 | 2026-06-05 |
| Orchestrator自动选中 | recommend-agents API始终包含Orchestrator在推荐列表中，确保群聊协调能力 | 2026-06-06 |
| 会话时间分组 | session-sidebar添加时间分组（今天/昨天/本周/更早），基于updatedAt字段 | 2026-06-06 |
| delegate任务状态修复 | chat-router.ts: delegate行为存在pending任务时自动切换为execute，确保任务状态正确更新 | 2026-06-06 |
| Agent越界防护P0 | orchestrator/index.ts: executeTaskBatch prompt注入declaredFiles约束，Agent只能修改声明文件 | 2026-06-06 |
| Agent越界防护P1 | execution.ts: 纠偏重试时从trace提取correction信息注入prompt，避免重复越界 | 2026-06-06 |
| 文档整理 | 归档5个已解决issues+7个已完成design docs，更新docs/README.md索引 | 2026-06-06 |
| 模型显示修复 | seed.ts预设Agent model改空+detect-platform返回defaultModel+详情页显示实际CLI模型 | 2026-06-06 |
| Agent详情页保存 | 受控组件+PUT API+保存状态反馈，名称/模型/SystemPrompt可编辑保存 | 2026-06-06 |
| 空字符串model bug | orchestrator/execution/chat 6处model: x.model改为\|\| undefined，防止400错误 | 2026-06-06 |
| ANTHROPIC_BASE_URL修复 | process-registry.ts: 无baseUrl时不再注入空字符串覆盖系统配置 | 2026-06-06 |
| 隐性行为准则 | AGENT_BEHAVIOR_RULES自动注入System Prompt：不假设项目、不主动读代码、简洁介绍等7条 | 2026-06-06 |
| Playwright E2E测试 | 真实浏览器验证：ChatFab完整流程✅、代码块渲染✅、消息菜单CSS限制、斜杠命令React限制 | 2026-06-07 |
| 核心逻辑审查修复 | 19个bug验证，10个修复：BUG-17(delegate转execute)、BUG-6(用户信息截断)、BUG-11(permission未await)、BUG-5(解析失败两次发言)、BUG-14(stuck task误重置)、BUG-16(SSE超时锁占用)、BUG-8/10(git快照误报)、BUG-15(空成员会话)、BUG-3(依赖ID静默忽略)、BUG-4(PM fallback缺prompt)。586测试全通过 | 2026-06-07 |
| QA视觉测试+修复 | Playwright截图QA：发现3个问题并修复——API Error友好提示(route.ts)、streaming状态清除防completed拼接(use-chat.ts)、创建Agent表单实时验证(create-agent-dialog.tsx)。586测试通过 | 2026-06-07 |
| API Error根因修复 | 3处修复：chat-router.ts onChunk拦截error转友好提示、orchestrator/index.ts error chunk不拼入result(防completed拼接)、config/orchestrator/route.ts移除硬编码model fallback。655测试通过 | 2026-06-07 |
| 硬编码模型fallback清理 | 移除config/orchestrator/route.ts 3处+app-config.ts 1处'claude-sonnet-4-20250514'硬编码，model为空时返回空字符串让CLI用环境默认值 | 2026-06-07 |
| status chunk过滤 | chat-router.ts+review.ts过滤status chunk不发送给前端(防completed拼接)，orchestrator/index.ts executeSingleAgent error chunk不拼入result | 2026-06-07 |
| 进程超时诊断日志 | process-registry.ts添加pid/stderr/exitCode详细日志，超时时输出完整诊断信息 | 2026-06-07 |
| 综合E2E测试(45项) | Session管理(8/8)+Agent管理(7/7)+Chat功能(6/6)+权限系统(1/1)+UI组件(6/6)+API层(12/17)。通过率88.9%，发现2个Bug | 2026-06-08 |
| GBK编码排查 | 确认非项目Bug：Python测试脚本在Windows GBK环境下写入U+FFFD脏数据，浏览器创建的Agent编码正确 | 2026-06-08 |
| AI协作流程文档 | docs/AI协作流程介绍.md：六步协作法、关键协作习惯、多Agent实践、协作工具链、协作效果 | 2026-06-08 |
| SSE超时锁泄漏修复 | chat/route.ts: 超时后streamClosed标志位防止往已关闭controller写入，避免后续请求被锁阻塞 | 2026-06-08 |
| 文档整理(二) | README.md测试数586→655+死链修正，docs/README.md移除4个不存在QA报告链接 | 2026-06-08 |
| Playwright E2E测试 | 13个无头浏览器测试：首页(6)+路由(3)+API(3)+交互(1)，全部通过 | 2026-06-08 |
| 视觉审查(4页面) | 首页/聊天/项目/智能体截图审查，发现Emoji乱码+重复会话+API 400错误 | 2026-06-08 |
| API 400根因修复 | Orchestrator model="test"→""，Setup Wizard CLI模式下默认值覆盖bug定位 | 2026-06-08 |
| Setup Wizard全流程测试 | 欢迎→CLI检测→测试连接→Agent平台设置→完成，发现model覆盖bug | 2026-06-08 |
| 群聊创建+@Agent测试 | 创建群聊→选择Agent→@后端工程师路由→代码生成+Orchestrator审偏 | 2026-06-08 |
| @所有人讨论测试 | 3轮×3Agent讨论：后端/Orchestrator/前端达成稳定性加固共识 | 2026-06-08 |
| 文件附件测试 | txt+png上传下载验证通过，10MB限制+白名单mimeType | 2026-06-08 |
| Bug1 Setup Wizard model覆盖修复 | setup-wizard.tsx: model默认值改空+CLI模式不发送model，3处修改 | 2026-06-08 |
| Bug2 群聊委派模糊匹配修复 | review.ts: delegateToAgent+runMultiAgentDiscussion精确匹配→模糊匹配+错误提示含可用Agent列表 | 2026-06-08 |
| Bug4 Agent编辑UI刷新修复 | agents/[id]/page.tsx: setAgent后同步name/model/systemPrompt受控状态+model空值传递 | 2026-06-08 |
| Bug5 数据库乱码清理 | 修复前端工程师expertise/systemPrompt+删除乱码自定义Agent+重命名3个乱码session+删除2个空session | 2026-06-08 |
| Session恢复统一 | 移除context拼接，Claude Code用--resume、OpenCode用--session，两个平台都通过CLI原生session恢复管理历史 | 2026-06-09 |
| StreamChunk事件补全 | 新增thinking/tool_use/tool_result三种事件类型，Claude Code和OpenCode解析逻辑都补全，前端展示thinking和toolCalls | 2026-06-09 |
| OpenCode适配5项修复 | Prompt传递(stdin只传用户消息)、SystemPrompt写入配置文件+--agent参数、工具限制(buildToolsYaml映射)、权限模式(--dangerously-skip-permissions)、工作目录(PWD三重锚定) | 2026-06-09 |
| OpenCode MCP集成 | ensureMcpConfig()将Claude Code MCP格式转换为OpenCode格式，通过XDG_CONFIG_HOME环境变量注入独立配置目录 | 2026-06-09 |
| OpenCode文件附件 | 通过--file参数传递附件路径，图片和非图片都走--file | 2026-06-09 |
| AGENT_BEHAVIOR_RULES重写 | XML结构化(role/behavior/interaction/collaboration/safety)，新增协作规则(任务完成汇报+里程碑汇报+阻塞上报+依赖说明+修改后测试)，含汇报模板和示例 | 2026-06-09 |
| 测试修复 | 12个测试更新(prisma mock+参数期望+错误消息)，658测试全部通过 | 2026-06-09 |
| SSE超时延长 | 5分钟→60分钟，支持复杂任务和多次重试 | 2026-06-09 |
| Orchestrator自动纠偏 | reviewResult新增retryContext参数，delegateToAgent路径自动重试(最多3次)，重试失败返回quality:'poor'，4新测试，664测试通过 | 2026-06-09 |
| Playwright QA测试 | 无头浏览器测试：Provider导入✅、同平台多Agent协作✅、跨平台协作✅、消息发送✅，健康评分90/100 | 2026-06-09 |
| 文档分类整理 | 按受众和生命周期分类：reports/新建、archive/三子目录、移动12个文件、删除课题.txt | 2026-06-09 |
| 弱断言测试修复 | 4个`expect(true).toBe(true)`改为验证具体行为：close()不调用registry、abort被触发、gracefulShutdown不调用spawn | 2026-06-09 |
| 死代码识别 | workspace.ts(工作空间沙箱+审计)和llm-adapter.ts(直接API调用)确认未被引用，保留备用 | 2026-06-09 |
| 测试覆盖率报告 | 84.89% Statements / 74.75% Branches / 81.36% Functions / 86.03% Lines，664测试全通过 | 2026-06-09 |
| GitHub上传 | 独立仓库 https://github.com/hhhhhhh520/agenthub ，77 commits完整历史，排除敏感文件(.env/dev.db/uploads/.opencode/.gstack) | 2026-06-09 |
| 文档清理 | README.md修复2个失效链接，PROGRESS.md补充最新变更记录 | 2026-06-09 |
| 聊天页滚动修复 | html/body加overflow-hidden锁定视口，侧边栏/聊天区/Agent面板加min-h-0+overflow-hidden约束高度，ScrollArea加min-h-0+overflow-hidden启用内部滚动，dashboard SidebarInset加overflow-y-auto | 2026-06-10 |
| 执行阶段上下文恢复 | execution.ts: 首次执行任务时Task.cliSessionId为空，fallback读SessionMember.cliSessionId（对齐阶段session），确保agent能resume讨论历史；执行完成后同步回SessionMember | 2026-06-10 |
| Orchestrator align_decompose提示 | prompts.ts: 告知Orchestrator即使没有架构师Agent，align_decompose也能正常工作（LLM fallback） | 2026-06-10 |
| Task空表兜底 | alignment.ts: transitionToExecution检查Task为空时自动调handleArchitectPlan补拆任务，确保执行阶段一定有任务；3个新测试，667测试通过 | 2026-06-10 |
| executeTaskBatch agentId隔离 | execution.ts: agents映射补传id字段，orchestrator/index.ts: agents类型加id、移除as any强转；修复并行Agent共享CLI进程导致输出相同的bug | 2026-06-10 |

### ⏳ 进行中
| 任务 | 状态 |
|------|------|
| （暂无） | |

### 📋 待办（2026-06-09 更新）

| 优先级 | 任务 | 说明 | 状态 |
|--------|------|------|------|
| ~~🔴高~~ | ~~Setup Wizard model覆盖~~ | ~~CLI模式下隐藏输入框但默认值仍发送~~ | ✅已修复 |
| ~~🔴高~~ | ~~群聊委派不执行~~ | ~~Orchestrator返回delegate决策后未调用delegateToAgent()~~ | ✅已修复 |
| ~~🟡中~~ | ~~项目详情页路由~~ | ~~缓存问题，重启后正常~~ | ✅已解决 |
| 🟡中 | 降级能力检查 | 备用模型能力校验（当前无备用模型配置） | 待定 |
| ~~🟢低~~ | ~~Agent编辑保存刷新~~ | ~~修改名称后UI未刷新显示新名称~~ | ✅已修复 |

**已评估不实施**：
- ORC-003（持续监督机制）— 纯规则检测误报率高，LLM 监控成本过高
- FAIL-003（确定性质量检测）— 应由 Code Review Agent 在工作流中完成
- Skill 功能 — CC Switch 已有方案，不在核心价值链上
- FAIL-005（上下文隔离回滚）— CLI 进程独立，上下文污染概率低
- FAIL-006 跳过/手动修复 — 跳过=下游缺前置产出不可用

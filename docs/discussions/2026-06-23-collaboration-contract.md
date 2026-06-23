# Agent 协作 Contract — 待定义

> 创建时间: 2026-06-23
> 起因: 一次"流程链路"问答 → 11 条 bug list → 两个 Claude 反复挑战后,确认 list 本身需要废弃
> 状态: **暂停**,留待下次新 session 专项处理
> 阅读时长: 10 分钟
>
> **本文档不是修复方案。是下次开始时的 entry point。**

---

## 一、为什么写这份文档

2026-06-23 的对话产出了 4 轮高密度讨论,核心结论是**当前列出的 11 条问题(原计划逐条修)不应作为待办清单**,因为它们绝大多数是 3 个架构级问题的下游症状。直接逐条修会:

- 代码量增加 ~20-30%
- 通道数量从 5 条增加到 6+
- 真实可靠性提升有限,因为 LLM 在多源信息冲突时表现不会因为修补单一通道而更好

这份洞察容易在新 session 中丢失 —— 新 Claude 看到 PROGRESS.md / 报告 / 历史记录,会还原出"11 条 bug list",看不到"list 已被废弃"这件事。

本文档存在的唯一目的:让下次重启时,新 session 看到的是 **结论 + 待答问题**,而不是 4 轮对话的肉。

---

## 二、今天确认的事实(不再讨论)

### 2.1 当前实现存在多通道协作,无 canonical

Agent 之间交接信息的通道至少 5 条,代码已确认:

| 通道 | 在哪 | 当前状态 |
|---|---|---|
| 跨批 results Map(executeTaskBatch) | `orchestrator/index.ts:315` | **跨 while 迭代丢失**(局部变量) |
| 上游文件(workDir / projectDir) | Agent 用 Read 工具读 | 依赖 LLM 自觉调用 + projectDir 真实可读 |
| Message 表(MCP post_message / read_messages) | `mcp-server/index.ts:108/133` | 依赖 DATABASE_URL 一致(见 2.3 风险) |
| discussionSummary(对齐讨论摘要) | `orchestrator/index.ts:321` | 已注入 prompt,但只在对齐阶段 |
| task.description 内的协议字段 | 架构师 prompt 决定 | 架构师 prompt 没强制 schema |

**没有任何一条被声明为"权威"**。Agent 在多通道并存时实际选哪条,是 LLM 行为,不可控。

### 2.2 11 条问题列表有依赖图,不是独立 checklist

之前列的问题(跨批 Map 丢、git diff 静默失效、monitoring 污染、cliSessionId 串话、runDiscussion 串行、findUnique 重复、private 漏 isCreateIntent、AbortSignal 未串联、LLM 输出关键词匹配、锁释放时序、SessionMember fallback)的严重性互相依赖:

```
#1 跨批 Map 丢失
  ↑ 严重性依赖
#3 git diff 在非 git 仓库静默失效  ← 兜底失效时 #1 立刻升高
#38 MCP DATABASE_URL 不一致        ← 兜底失效时 #1 立刻升高
```

**修单个问题前必须先看依赖根**。当前未画完整依赖图。

### 2.3 几个已知的具体技术坑(代码已确认)

- **MCP DATABASE_URL 不一致**(#38): `mcp-config.ts:14` 硬编码 `file:${cwd}/dev.db`,而 mcp-server/index.ts:11 用 `process.env.DATABASE_URL || 'file:./dev.db'`。设了 DATABASE_URL 指别处 → 主进程 vs MCP 操作不同 DB → Agent 互发消息查不到
- **git diff 静默失效**: `execution.ts:107` 的 `getGitSnapshot` 在非 git 仓库返回空,越界检测完全失效。Agent 改了什么都不会被报警
- **declaredFiles 只是软提示**: `orchestrator/index.ts:376` 在 prompt 里写"只能修改 X",但 CLI 工具白名单管不到路径,Agent 实际可改任何文件

这些不是本次讨论的"决策对象",而是下次任何 contract 决策都需要参考的客观约束。

### 2.4 当前 runDiscussion 是接力独白

`orchestrator/index.ts:548` 的 runDiscussion:
- 后说话的 Agent 看到前面 Agent 的 opinions(轮内 + 轮间)
- 但没有结构化 critique、共识检测、意见聚合
- 最终 opinions 数组直接 join 当结果用,没有 summarizer 合成决策

**这是事实陈述,不是评价**。LLM 之间的"讨论"是否需要人类辩论那三件套(critique/consensus/aggregation),是开放问题(见第三节)。

### 2.5 LLM-审-LLM 不是"约定 + 守门员"模式

第四回合的关键洞察:HTTP/TypeScript/DBA 的弱 canonical 之所以成立,是因为审查者(浏览器/eslint/人)比被审查者更可靠。

AgentHub 的 monitoring Orchestrator 是 LLM 审 LLM,审查者跟被审查者**同质、同阶错率**,monitoring 自己还会上下文污染。

**结论**:这个项目在"由 LLM 自我监督协作可靠性"这条路上做不到弱 canonical。要么放弃 canonical(降低期待),要么引入非 LLM 守门员(架构改造)。

---

## 三、今天确认的开放问题(下次回答)

按依赖顺序排,**必须从问题 1 开始**:

### 问题 1: AgentHub 里 Agent 协作的 contract 应该是什么?

候选答案(每个三五句话):

| 选项 | 含义 | 代价 |
|---|---|---|
| **File-as-contract** | Agent 之间通过 workDir 文件交付;Message 表只用于人看,不用于 Agent 协作 | 要求 projectDir 稳定、是 git 仓库;Agent 必须真去 Read |
| **Message-as-contract** | Agent 强制 post_message 发结构化交付物;文件只是副产品 | 先修 DATABASE_URL 坑;架构师 prompt 改写 |
| **Task.handoff-as-contract** | 拆任务时强制声明 handoff schema(类似 OpenAPI);下游基于这个 schema 工作 | schema migration;架构师 prompt 重写;需 JSON Schema 校验 |
| **没有 canonical,接受多通道现实** | 项目定位降级为"辅助 + 用户兜底" | 心态调整,不追求复杂任务自治 |

**不要在没回答这个之前,展开任何下游问题。**

### 问题 2: LLM-审-LLM 是否可行?如果不可行,引入什么非 LLM 守门员?

候选守门员(从轻到重):

- **JSON Schema 验上游交付物** — 上游必须输出符合 schema 的结构化结果,解析失败直接拒收
- **依赖关系硬检查** — 下游开跑前,确定性程序检查上游声明的 declaredFiles 是否真存在
- **MCP 工具收敛** — 砍掉冲突通道(比如禁用 read_artifact,强制走 read_messages 一条路径)
- **接受失败,加快反馈** — 不试图防 Agent 出错,而是让出错快速可见,用户介入

### 问题 3: per-agent 连续性应该 default-on / default-off / task-aware?

`execution.ts:161` 的 fallback 当前是 **implicit default-on**(Task 第一次跑必然背着 SessionMember 历史)。

候选:
- default-on(当前)
- default-off
- **task-aware**(根据 task.dependencies 决定:不依赖时新建 session,依赖时续 cliSessionId)

依赖问题 1 的答案。如果 contract 是 File-as-contract,per-agent 连续性影响较小(信息走文件);如果 Message-as-contract,串话风险更高,该 default-off 或 task-aware。

---

## 四、下次 session 的 entry point

打开新 session 时,扔进去这段:

```
读 docs/discussions/2026-06-23-collaboration-contract.md,
我们要回答第三节的问题 1。先不进代码,先讨论。
30 分钟之内不要扔修法建议。
```

或者更激进:

```
读 docs/discussions/2026-06-23-collaboration-contract.md。
我已经决定 contract 是 [X]。请基于这个决策,重新评估
src/lib/services/execution.ts、src/lib/orchestrator/index.ts、
src/mcp-server/index.ts、src/lib/mcp-config.ts 里,哪些通道
应该砍、哪些应该保留、哪些应该重写。
```

---

## 五、本文档不写的东西(刻意省略)

为了下次思考不被污染,**不**写以下内容:

- 当前会话两个 Claude 各自倾向哪个 contract 选项
- 11 条 bug list 的逐条修法建议
- 任何"如果我是你我会选 X"的话

理由:今天的讨论热度可能放大了某些方向的"听上去对",新 session 隔一段时间后,你自己会有更清醒的判断。

---

## 六、元结论(校准用,非操作指南)

今天的对话校准了对 Claude 协作的认知:

- **局部分析能力**: 两个 Claude 都强,能引到行号、能追因果链
- **元问题视角**: 两个都能在被挑战时跟上,但单独都不会主动升上去
- **架构决策能力**: 两个都做不到,这是用户的事
- **协作产出**: 两个 Claude 互相挑战(用户中转),比单独提问产出高一档,但有边际递减

**实操含义**: 复杂决策不要靠单个 Claude 一次性回答。要么用户自己跨 session 校准,要么显式开两个 session 互相挑战。这份文档存在本身就是后一种工作模式的成果。

---

## 七、状态

- [x] 落盘
- [ ] 下次重启 session 时,以本文档为 entry point
- [ ] 回答问题 1
- [ ] 基于问题 1 的答案,决定问题 2 和 3
- [ ] 基于三个答案,重新评估当前 11 条 bug list 中哪些自动消失、哪些升级、哪些保持

---

> 这份文档不是给将来"完成"的,是给将来"接着想"的。
> 想完了之后,这份文档本身可能也需要废弃。那是好事。

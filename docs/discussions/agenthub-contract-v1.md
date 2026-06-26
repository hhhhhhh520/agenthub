# AgentHub Agent 协作 Contract v1

> 创建时间: 2026-06-23
> 状态: **已生效**(尚未实现,但作为后续工程动作的源头规约)
> 前置文档: `docs/discussions/2026-06-23-collaboration-contract.md`(思考过程档案,已答完)
> 阅读时长: 5 分钟

---

## 0. 产品定位前置(决定一切的根)

**AgentHub = 自驱动多 Agent 协作平台(X 定位)**。

用户扔需求 → 架构师拆 → 多 Agent 并行 → 自动交付。人不在回路中段。

不是"多 Agent IDE"(Y 定位 — 用户随时介入、Agent 是辅助工具)。

**所有下文契约的成立前提是 X**。如果未来项目漂移到 Y,本契约可作废重议。

---

## 1. 三条契约

### 1.1 数据流契约 — 确定性接线

orchestrator 在生成下游 Agent 的 prompt 时,**确定性地**从以下两处取上游交付物,拼进 prompt 的固定位置:

- **主源**: `task.result` 字段(持久化到 DB,跨批可读)
- **辅源**: `workDir` 下的文件(LLM 工作过程的产物,人能看 + 影子 git 能验证变更)

下游 LLM **不再自行决定**走哪条通道。它在 prompt 里看到什么,就是 orchestrator 决定让它看到什么。

#### 被废弃 / 降级的通道

| 通道 | 处置 | 理由 |
|---|---|---|
| 跨批 results Map(orchestrator 局部变量) | ❌ 废弃 | 改由 task.result 持久化 |
| discussionSummary 注入 prompt | ❌ 废弃 | 不再是 Agent 间信息载体 |
| declaredFiles 软提示 | 🔁 升级为硬校验(见 1.2 b) | 软提示无约束力 |
| Message 表 | 🔽 降级 | 只用于 Agent 间旁路对话(讨论、Q&A),不承担交付 |
| task.description 协议字段 | 🔽 废弃概念 | 输入协议由 schema + declaredFiles 表达 |

### 1.2 可信度契约 — 双层校验

上游 task.result 必须通过**两层校验**才被 orchestrator 注入下游 prompt:

**a. JSON Schema 软校验**(2026-06-23 实施动作 5 时修订为降级版)
- 架构师在拆 task 时,为每个 task 声明简化 output_schema(数组,每元素 `"字段名:类型 - 说明"`)
- 任务跑完后,从 task.result 末尾提取 JSON 块(优先 ```json``` fenced,fallback 裸 `{...}`)
- **分级判定**:
  - **outputSchema 为空 / 未声明** → 跳过校验
  - **找不到 JSON 块 / 解析失败 / 缺少声明字段** → **软警告**(发消息提示用户),任务仍 completed,下游照常启动
  - **字段名齐全** → 通过(不强校验值类型,因 LLM 类型表达不稳)

**为什么不按 contract 原版"硬校验失败=任务 failed"**:
- output_schema 当前仅由下游 LLM 通过 `<dependency>` prompt 标签消费,下游读自由文字就够,不需要程序化 JSON 解析
- 未要求下游 Agent 必须按格式输出 JSON 块(那需要 prompt 增加约束 + 接受高频误伤)
- 硬校验拦的主要是"格式问题"而非"内容问题",LLM 协作的真实失败模式是内容问题
- 与动作 6(declaredFiles 分级校验)对称的软语义:警告可见 + 不阻断流程
- 留升级空间:未来若有"非 LLM 步骤需要读结构化上游产出",可改为硬失败

**b. declaredFiles 分级校验**(2026-06-23 实施动作 6 时修订)
- 架构师在拆 task 时,为每个 task 声明 declaredFiles(声明会改哪些文件)
- 任务跑完后,通过影子 git(`git --git-dir=... --work-tree=<workDir> diff`)实际验证
- **分级判定**:
  - **敏感路径越界** → 任务标记失败,下游不启动(硬失败)
    - 敏感路径包括: `.env*`, `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `prisma/schema.prisma`, `.gitignore`, `tsconfig*.json`, `next.config*`, `node_modules/**` 等
  - **普通越界** → 自动清理越界文件(保留其他批次声明的文件) + 任务仍 completed,下游照常启动
  - **遗漏(声明了但实际没改)** → 警告并记录,不影响任务状态(软警告)
- declaredFiles 为空数组 → 跳过文件校验(允许无文件改动的任务存在,如纯讨论/分析)

**为什么不按 contract 原版"声明全等"硬校验**:
- 架构师 LLM 不掌握真实代码结构,文件声明本质是猜测;
- Agent 顺手改邻近文件(import、types)是常态,硬失败会让 90%+ 任务挂掉;
- X 定位(自驱动)下用户不在回路兜底,硬失败级联无人挽回;
- 敏感路径硬失败兜住"重大破坏"(改 `.env` / 改依赖),其他越界靠告警 + monitoring 纠偏即可。
- 这是实施中发现"合同字面与现实冲突"的明确妥协,见第 6 节失效条件"实施中发现 what 站不住,回来改这份"。

任一层不过 → 任务失败 → 下游不启动(b 的"任一层"指敏感路径越界)。

#### 强制前提

- **AgentHub 用"影子 git"追踪 workDir 变更,workDir 本身不受影响**。
  - 影子 git 元数据存在 AgentHub 私有目录(如 `<project-root>/.agenthub/shadow-git/<sessionId>/`),通过 `git --git-dir=... --work-tree=<workDir>` 调用
  - 用户的 workDir 不会被 `git init`,不会出现 `.git` 目录,用户感知不到 git 的存在
  - 用户如果自己已经在 workDir 跑过 git init,两套 git 视角并存,互不干扰
  - 原 bug list #3(`getGitSnapshot` 在非 git 仓库静默返回空)从"边缘 bug"升级为"必修阻塞项":必须改为影子 git 模式,不再依赖 workDir 自身的 git 状态
- 架构师 prompt 必须重写:不仅拆 task,还要为每个 task 声明 output schema 和 declaredFiles。

### 1.3 连续性契约 — default-on(带护栏)

Agent 跨 task **默认保留 cliSessionId**(`claude --resume`)。Agent 在跨 task 时记得自己说过什么、做过什么。

**接受这个选择带来的隐患**: 同一份信息 Agent 会看到两次(一次进程内存历史 + 一次 prompt 注入)。当两次不一致(task.result 中途修正、用户改主意、对齐推翻早期决定),LLM 决策不可控。

#### 必须配套的护栏

| 护栏 | 作用 | 优先级 |
|---|---|---|
| task.result 修正时 invalidate 相关 cliSessionId | 强制起新 session,避免历史脏数据 | P0 |
| prompt 注入放最末尾 + 显著分隔符 + "以此为准"声明 | 引导 attention 偏向新内容 | P0 |
| ~~历史长度上限(超过 N 轮自动起新 session)~~ | ~~防止历史膨胀挤掉 prompt 注入~~ | ~~P1~~ **降级不做** |
| debug 钩子(dump 进程历史 + 注入 prompt 双份) | 出错时人能对比定位 | P1 |

**"历史长度上限"为什么不做**(2026-06-23 实施动作 9 时修订):
- Claude Code / OpenCode CLI 内置历史压缩(compact)机制,Context 撑满前 CLI 自己处理
- 我们要拦的不是"context 满"(CLI 已管),而是"Agent 带过时角色感继续干" —— 后者只跟"是否经历过 task.result 修正/纠偏/敏感失败"相关,跟历史长度无强相关
- 真正解决"过时角色感"的是 P0 第一条(纠偏/失败时主动 invalidate),不是按轮数定时重置
- 按轮数强制重置反而会让"还没经历过修正,本该连续的 Agent"被打断,丢掉合理的角色记忆
- 见第 6 节失效条件"实施中发现 what 站不住,回来改这份"

**P0 护栏不做,1.3 不成立,等同于 default-off 选错。**

---

## 2. 三条契约的逻辑关系

```
1.1 确定性接线  ←──  解决"通道太多 LLM 选错"
   │
   ↓ 但 orchestrator 取的内容本身可不可信?
   │
1.2 双层校验  ←──  解决"上游交付物可能错"
   │
   ↓ Agent 跨 task 怎么处理历史?
   │
1.3 default-on + 护栏  ←──  保留角色感,接受张力,加护栏对冲
```

1.1 是地基。1.2 是地基上的承重墙。1.3 是装修偏好,但装修不当地基会裂。

---

## 3. 对原 11 条 bug list 的连锁影响

| # | 原 bug | 命运 | 备注 |
|---|---|---|---|
| 1 | 跨批 results Map 局部变量丢失 | ✅ 消失 | 1.1 已弃用 results Map |
| 3 | git diff 非 git 仓库静默失效 | 🔴 升级阻塞项 | 1.2 b 的前提 |
| 38 | MCP DATABASE_URL 不一致 | 🟡 降级 | Message 表降级后影响面缩小,但坑还在 |
| - | monitoring 嵌套 Orchestrator 污染 | ⚪ 保留 | 跟 contract 无关,纯执行层 |
| - | cliSessionId 串话 | 🔴 加重 | 1.3 选 on 后风险更高,P0 护栏必修 |
| - | runDiscussion 串行 | ⚪ 保留 | 跟 contract 无关 |
| - | findUnique 重复 | ⚪ 保留 | SQLite 下不急 |
| - | private 漏 isCreateIntent | ⚪ 保留 | 独立 bug |
| - | AbortSignal 未串联 | ⚪ 保留 | X 定位下值得做,但跟 contract 无关 |
| - | LLM 输出关键词匹配 | ✅ 可能消失 | 1.2 a JSON Schema 落地后被替代 |
| - | 锁释放时序 | ⚪ 保留 | 独立 bug |
| - | SessionMember fallback | 🔴 加重 | 1.3 选 on 后是默认行为,要确认跟 invalidate 护栏不打架 |

---

## 4. 接下来的工程动作(高层次,具体修法另议)

按依赖排序:

1. **修 #3 git diff 非 git 仓库静默失效** — 1.2 b 的前提。改造为**影子 git 模式**(`<project-root>/.agenthub/shadow-git/<sessionId>/`),用户 workDir 不被 git init
2. **task.result 持久化到 DB** — 1.1 的主源载体
3. **架构师 prompt 重写** — 拆 task 时声明 schema + declaredFiles
4. **orchestrator prompt 组装重写** — `executeSingleAgent` 改为确定性注入
5. **JSON Schema 软校验代码** — 1.2 a (2026-06-23 修订:降级为软警告,与动作 6 对称)
6. **declaredFiles 分级校验代码** — 1.2 b (2026-06-23 修订:敏感路径硬失败 + 其他越界软警告)
7. **cliSessionId invalidate 机制** — 1.3 P0 护栏
8. **prompt 注入分隔符 + 声明** — 1.3 P0 护栏
9. ~~**历史长度上限**~~ — 不做(CLI 内置 compact 已管,见 §1.3 修订);debug 钩子按需添加

具体修法、文件改动、测试用例,**留待新 session 专项处理**。本契约只定 what,不定 how。

---

## 5. 已知不解决的事

为避免本契约边界蔓延,明确**不在本契约范围**:

- monitoring 嵌套 Orchestrator 的污染(独立 bug,跟 contract 无关)
- runDiscussion 串行(独立优化点)
- AbortSignal 未串联(重构工程,独立议题)
- 性能优化类(findUnique 重复、锁释放时序)
- 跨 session 的人工介入路径(私聊、@提及等)

这些事归"bug list 维护"或"性能议题",不归"协作 contract"。

---

## 6. 失效条件

以下任一条件成立时,本契约需要重新评估:

- 项目定位从 X 漂移到 Y
- 影子 git 模式在实际跑动中出现严重问题(性能、跨平台、状态同步)
- 架构师 prompt 无法可靠输出 schema(LLM 能力不足以稳定生成 JSON Schema)
- task.result 双向校验在实际跑动中错误率过高(LLM 反复生成不符 schema 的内容)
- 1.3 的 P0 护栏被证明无法阻止历史/注入冲突

---

## 7. 状态

- [x] 三道题已答(2026-06-23)
- [x] 落盘为正式 contract
- [ ] 工程实现(待新 session 专项处理)
  - [x] 动作 1: 影子 git 模式追踪 workDir 变更(2026-06-23, commit 8417ccf / e851160)
  - [x] 动作 2: task.result 持久化到 DB(2026-06-23) — Task 表加 `result String?`,executeTaskBatch 接受 priorResults,handleExecution 启动时从 DB 读旧 result、跑完后写回 DB
  - [x] 动作 3: 架构师 prompt 重写 + outputSchema 持久化(2026-06-23) — Task 表加 `outputSchema String?`,TASK_DECOMPOSITION_PROMPT 增加 output_schema 字段+强化 declared_files 校验语义,alignment.ts 和 decomposeTasks 同步解析持久化(校验逻辑留待动作 5)
  - [x] 动作 4: orchestrator prompt 确定性注入(2026-06-23, commit a552db3) — executeTaskBatch 新增 priorTaskMeta 参数,依赖结果以 `<dependency name="..." output_schema="...">` 结构化注入下游 prompt,删除 discussionSummary 注入,截断保护改为通用形式
  - [x] 动作 6: declaredFiles 分级校验(2026-06-23) — 实施时修订 contract §1.2 b 为分级语义。新增 sensitive-paths.ts(敏感路径黑名单:.env / package.json / prisma/schema.prisma / node_modules/ / 配置文件等)。execution.ts 越界检测后:敏感越界 → 任务硬失败 + 下游 blocked + 不写 result;普通越界 → 自动清理越界文件(保留其他批次声明的文件) + 任务仍 completed;declaredFiles 为空 → 跳过校验。20 sensitive-paths 单测 + 5 集成测试 + 8 越界清理单测
  - [x] 动作 5: outputSchema 软校验(2026-06-23) — 实施时修订 contract §1.2 a 为软语义,与动作 6 对称。新增 schema-validator.ts(提取 result 末尾 JSON 块 + 字段名比对)。execution.ts 在普通越界检测后插入校验:no-schema/ok 静默,no-json/parse-error/missing-fields 发警告但任务仍 completed。20 schema-validator 单测 + 3 集成测试
  - [x] 动作 7: cliSessionId invalidate 机制(2026-06-23) — §1.3 P0 护栏。execution.ts 在两个事件清 cliSessionId:**敏感越界硬失败** → 同时清 task.cliSessionId 和 SessionMember.cliSessionId(避免该 agent 进程内存里"我交付成功"的错误信念污染后续任务);**monitoring 纠偏退回 pending** → 同时清两层 cliSessionId(task.result 即将被推翻,agent 历史里"我做对了"的认知是脏数据)。正常完成路径不动 cliSessionId。3 集成测试
  - [x] 动作 8: prompt 权威包装(2026-06-23) — §1.3 P0 护栏。orchestrator/index.ts 的 prompt 组装在依赖块 + 文件约束 + 任务描述外层包一层 `<authoritative_input> ... </authoritative_input>`,头部声明"如与历史冲突,以下内容为准,历史作废"。CLI 历史在 prompt 之前由 --resume 拼接,本包装放在历史之后利用 LLM 末尾注意力偏向。截断保护同步保留头尾标签完整。4 测试
  - [x] 动作 9: 历史长度上限(2026-06-23,**降级不做**) — 实施动作 9 前发现 Claude Code / OpenCode CLI 内置 compact 机制已处理 context 增长问题。我们要拦的不是"context 满"(CLI 已管),而是"Agent 带过时角色感继续干" —— 后者由动作 7 的事件型 invalidate 解决,跟历史长度无强相关。按合同第 6 节"实施中发现 what 站不住,回来改这份"原则,在 §1.3 修订表格,将"历史长度上限"标 ~~删除~~。debug 钩子按需添加,本批次未实施
- [x] 在 PROGRESS.md 引用本契约(2026-06-23)
- [ ] 跑通端到端最小用例验证 contract 可行性

---

> 这份文档定 what,不定 how。
> how 在新 session 里基于本 what 展开,实现过程中如果发现 what 站不住,回来改这份。

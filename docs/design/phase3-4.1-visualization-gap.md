# §4.1 trace 可视化升级 —— 现有 analytics 页到目标页的差距清单

> 创建时间: 2026-09-26 | 状态: 🟡 清单完成，待拍板实施顺序
> 关联: docs/design/roadmap-to-excellence.md §4.1（验收=3 真实会话盲测 5 分钟可解释"在哪一步跑偏、被什么机制拦住"）

## 0. 结论（TL;DR）

- **最大缺口是"单会话 trace 视图"整层缺失**：`/api/sessions/[id]/process` 端点已建成但**零前端消费方**（grep 全 src 无调用）——盲测验收必须落到"单个会话怎么看"，没有这一层 §4.1 无法验收。
- 聚合页（231 行最小页）三块都在，但都是**只读表格**：无图形、无下钻、无跳转；casRejectCount（ISSUE-025）已随 API 返回但未展示。
- 纠偏时间线完全缺失——数据（ts/decisionPoint/corrections/llmProposal.reason）在 decisionTrace 里齐全，只差 UI。

## 1. 现状盘点（数据 → API → UI 三层）

### 数据层（齐全，§4.1 无需新增采集）

| 数据源 | 内容 | 与可视化的关系 |
|---|---|---|
| `Session.decisionTrace` | 决策条目：decisionPoint / inputState / llmProposal(action+reason) / corrections[]（from→to+reason）/ validation / actualTransition(applied/escalated/casRejected) / ts | 纠偏时间线的原始流；封顶 500 条/会话 |
| `Task.trace` | 执行层信号：start/error/success/correction/blocked + event:'monitor'（P11 反事实）/ event:'preflight'（S3 灯） | "被什么机制拦住"的执行侧证据 |
| `AgentProcessEvent` | §3.1 持久化的四类过程事件（seq 化，500 条/会话） | 时间线下钻的过程细节（可选叠加） |
| `checkConformance` 返回值 | total/conforming/escalateCount/correctionCount/**casRejectCount**/violations/ratio（decision-trace.ts:144-160） | casRejectCount 两端点均已返回 |

### API 层（两端点，一冷一热）

- `/api/analytics/process`（route.ts:19-48）：全局聚合 conformance+process+variants+sessions 列表，analytics 页唯一消费方。已知口径：violations **不含 sessionId**（route.ts:15 注释明说"消费方需自行定位归属"）；只扫最近 1000 traced。
- `/api/sessions/[id]/process`（route.ts:15-35）：单会话 conformance+process+variants。**零 UI 消费方**（⚠️ 未集成项——本清单 G1 即它的归处）。

### UI 层（src/app/(dashboard)/analytics/page.tsx，231 行，P4 T6 最小页）

| 块 | 现状 | 缺什么 |
|---|---|---|
| Conformance | 4 个 Stat（一致性/升级/纠正/转移总数）+ violations 表 | casRejectCount 未展示；violations 无会话归属；escalate_but_legal（代码漂移 bug）与 escalate（按设计拦截）同表无视觉分级 |
| Directly-Follows | 纯表格（从/动作/到/次数）+ 每状态信号 chip | 无图形化——"在哪一步跑偏"没有空间直觉；6 节点小图不需要图库 |
| 流程变体 | 列表：id/状态序列/次数/纠正/升级 badge + sessionIds 纯文本 | sessionIds 不可点击，与具体会话断链 |
| 纠偏时间线 | **不存在** | corrections/ts/decisionPoint/reason 数据齐全，无任何展示 |
| 会话导航 | analytics 页 ↔ chat 会话互不连通 | 验收要求"随机抽 3 个真实会话仅用 dashboard"——需要从会话到 trace 视图的入口 |

## 2. 差距清单（G1-G5，按验收贡献排序）

### G1 单会话 trace 视图（决定项，未集成端点的归处）

- 新增视图消费 `/api/sessions/[id]/process`（端点现成）+ Task.trace / AgentProcessEvent（可选下钻）。
- 核心 = **纠偏时间线**：按 ts 排序的决策条目流，每条展示：
  决策点（decisionPoint）→ LLM 提议（action + reason 摘要）→ 被什么拦（corrections[].from→to+reason / escalated / casRejected 徽标）→ 实际转移（applied 转移箭头）。
- 盲测问题"在哪一步跑偏"= 时间线第一条非 conforming 条目；"被什么机制拦住"= corrections 原因或 escalate 徽标 + violations kind。
- 落点建议：`/analytics/sessions/[id]` 子路由（不动 chat 页），入口从变体/会话列表跳入（G4/G5）。

### G2 conformance 视图补 casRejectCount + violations 会话归属（接续文档点名的顺带项）

- 聚合页 Stat 行加"CAS 拒绝回执"（hint：并发 fail-closed，系统按设计工作）。
- violations 会话归属：API 侧给每条 violation 补 sessionId（跨 session 条目循环内可归属，checkConformance 纯函数不动）或前端按 sessions 逐个拉单会话端点聚合——前者一次改 +1 测试，后者零 API 改动但 N 次请求。建议前者。
- escalate_but_legal 加红色警示样式（漂移 bug 信号，roadmap §1 的 A 方向核心监控点）。

### G3 DFG 图形化（可后置）

- 6 状态 + 权重边的小图：无新依赖原则（P4 T6 先例）下用内联 SVG 静态布局（STATE_ORDER 环形/线性排布 + 边粗细=count），或退一步"表格 + 热点边高亮"。
- escalate/correction 信号叠加在节点上（stateSignals 已有，每状态信号 chip 已是雏形）。

### G4 变体 → 会话跳转（闭环 G1 入口）

- sessionIds 纯文本 → 可点击链接（跳 G1 视图）；变体卡片补 casReject 维度（数据来自逐会话 checkConformance，聚合计数需 API 微调，可先不做）。

### G5 会话间导航

- dashboard 首页（会话列表）加 trace 视图入口（或 chat 页内嵌链接）；G4 的反向。

## 3. 实施顺序建议与验收

```
G1（含时间线） → G2（顺带，一次 commit） → G4 → G5 → G3（最后）
```

- 验收（roadmap §4.1 原文）：随机抽 3 个真实会话，不看代码、仅用 dashboard，5 分钟内说出"这次协作在哪一步跑偏、被什么机制拦住"。
- 盲测路径依赖 G1（时间线）+ G4/G5（入口）。G3 图形化对盲测非必需，排最后。
- 约束：无新依赖（P4 T6 先例）；零 schema 变更；前端改造不碰写点清单（只读消费）；沿用现有 Badge/表格风格与 STATE_LABELS 中文映射。

## 4. 风险与边界

- violations 补 sessionId 后，聚合拍平语义（route.ts:13-16 已知边界）需在 UI 上明示"下标为全局序号"或改为逐会话分组展示——避免误导。
- 单会话空 trace（entries=[] → 空签名变体）与聚合口径不同（route.ts:11-13 注释），G1 视图空态文案要区分"无 trace"与"有 trace 未推进"。
- decisionTrace 封顶 500 条：超长会话时间线只见最近 500 条（warn 已有，UI 可加"已截断"提示，P4 T2 拍板口径）。

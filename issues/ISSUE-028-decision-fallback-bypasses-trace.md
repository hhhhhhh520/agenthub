# §4.1 盲测验收发现：决策 LLM 失败静默回退绕过状态机与 trace，主库 24 会话零决策轨迹
> 创建时间: 2026-09-30 | 状态: 🔴未解决

## 问题描述（盲测验收 = 3 真实会话，仅用 dashboard 5 分钟说清"哪一步跑偏、被什么机制拦住"）

验收执行（2026-09-30，ISSUE-027 四 commit 修复后，opencode + tokenrhythm/mimo-v2.6-flash 线路）：
真实创建了 2 个群聊会话并各发真实开发任务（温度换算工具 / Markdown 笔记工具），外加此前 API 级讨论冒烟 1 个会话。**讨论与执行已完全正常**（8/8 agent 两轮真实发言、工具调用成功、测试跑通），但 **§4.1 验收判定：未通过**——三个会话的决策时间线全部 0 条，"哪一步做了什么决策"无从谈起。

## 根因链（证据齐全）

1. **决策 LLM 解析失败静默回退**（chat-router.ts:71-78）：`getOrchestratorDecision` 抛非超时错误（极可能是 mimo 推理模型输出不含可解析 JSON——parseJSON 在 `src/lib/orchestrator/index.ts:233` 抛 `Failed to parse JSON from: <前200字符>`）→ catch 分支 **静默调用 handleOrchestratorChat**（带工具直连）→ return。**不打一行日志、不记 trace、不发决策事件**。
2. **回退路径绕过状态机**：handleOrchestratorChat = executeSingleAgent 带工具直连——orchestrator 自己干活（会话 A：核实文件已存在如实报告；会话 B：直接实现 notes.js + git 存档 + 测试 3/3），但这是"agent 越权代 orchestrator"，**align_confirm → align_decompose → execute 管线与全部治理观测（decisionTrace/CAS/纠正计数）被整体跳过**。
3. **佐证**：dev 日志仅 1 条 `[TIMEOUT] getOrchestratorDecision`（另一消息），其余决策尝试无任何日志（静默回退不打日志的直证）；全库 24 会话 decisionTrace 无一非空；task 表 0 行（管线从未触发）。
4. **连带 bug**：`agenthub_read_messages` MCP 工具在有 5 条消息的会话返回「暂无消息」（orchestrator 因此声称"这是我们对话的第一条消息"）——消息读取链路待查。

## 验收中验证为正常的部分
- 讨论（@所有人）：8/8 agent 两轮真实中文发言、逐轮收敛，0 超时 0 出错（commit 1ab265f 修复 agentId 空格触发 arg-safety 后）。
- 直连工具执行：真实创建文件、git 存档、node --test 3/3 通过，聊天 UI 的工具调用卡片渲染清晰。
- 合成错误拦截、真错误透传：未再出现 401/Unpurchased/超时黑箱。
- /analytics/sessions/[id] 空态文案诚实（"尚未跑协作流程或轨迹为空"）。

## 修复方向
1. **chat-router :71-78 回退必须显性化**：非超时错误打 `console.error`（含 parseJSON 截断文本）+ sendEvent 告知用户「决策解析失败，已直连处理」+ **记一条 trace**（action:'self', reason:'决策解析失败回退'）——治理观测不允许静默旁路。
2. **mimo 决策 JSON 兼容**：决策 prompt 输出约束强化 / parseJSON 失败时把原始文本写日志便于诊断 / 考虑决策调用换非推理小模型（快且听话）。
3. **agenthub_read_messages 返回空**：排查 MCP 工具的 session 过滤条件。
4. **管线触发率**：mimo 决策不稳定导致管线几乎不可达——考虑决策模型与执行模型分离（决策用快模型）。

## 相关文件
- `src/lib/services/chat-router.ts:71-78`（静默回退点）、`src/lib/orchestrator/index.ts:233`（parseJSON）
- `src/app/api/sessions/[id]/chat/route.ts:183`、`src/lib/orchestrator/decision-trace.ts`
- 验收环境：ISSUE-027 四 commit（e4d7796/d62f5cf/f64d2e7/1ab265f）+ dev server 重启 + 2 个真实群聊会话

## 参考资料
- roadmap §4.1 验收标准；memory `claude-cli-model-catalog-reject`（CLI 行为矩阵）

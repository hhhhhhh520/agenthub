# OpenCode v2.2.5 CLI 兼容性与动态 Agent 失效

> 创建时间: 2026-11-04 | 状态: 🟢 已解决 | 发现于 U13 golden path 回归

## 问题描述

U13 首次真实跑 golden path 时连续出现三类错误：

1. `Unrecognized flag: --dir in command opencode run` — 所有 OpenCode CLI 调用直接退出。
2. `Agent not found: "agenthub-<id>-<hash>"` — 动态写入的 `.opencode/agents/*.md` 不被识别。
3. Orchestrator 决策返回自然语言 / `{"role":"产品经理"}` / `{"agent":"...","prompt":"..."}`，甚至自创 `action:"speak"`，导致对齐流程无法推进。

## 出现原因

| # | 根因 | 证据 |
|---|---|---|
| 1 | 本机 OpenCode 已升级到 v2.2.5，`run --dir` 被移除；适配器仍在传 | `opencode run --help` 无 `--dir`；日志 `Unrecognized flag` |
| 2 | OpenCode 后台服务缓存 agent 列表；AgentHub 每次调用动态写 agent 文件，后台服务看不到 | 不带 `--standalone` 必现 `Agent not found`；带上即成功 |
| 3 | `getOrchestratorDecision` 调 `executeSingleAgent` 时没传 Orchestrator 的 `id` | 适配器 `agentName()` 返回 null → 不写 agent 文件、不传 `--agent`，system prompt 完全不生效 |
| 4 | 决策调用仍套 `buildAgentSystemPrompt` 的身份 + behavior 包装，且工作目录在项目内，会加载 `AGENTS.md` | 模型进入聊天/项目助手人格，忽略 JSON-only 约束 |
| 5 | provider 前缀 model（`opencode-go/...`）在 Agent 无 key 时仍被 CC-Switch 旧凭据覆盖 | 决策请求打到余额不足的 tokenrhythm，返回 HTTP 402 |

## 解决方案

| 文件 | 修改 |
|---|---|
| `src/lib/adapter/opencode-adapter.ts` | 删除 `--dir`；参数改为 `run --standalone --format json`；工作目录由 `spawn.cwd` + `PWD` 锚定 |
| `src/lib/orchestrator/index.ts` | `getOrchestratorDecision` 传 `id: orch.id`；新增 `rawSystemPrompt` 跳过身份/behavior 包装；`ANALYSIS_WORKDIR = tmpdir()/agenthub-analysis` 用于决策/结构化调用；`normalizeDecision` 容忍缺 `reason/message`、拒绝非法 action；`getOrchestratorAgent` 对 `provider/model` 不再走 CC-Switch 兜底；任务 prompt 增加 `[产出格式]`（`outputSchema` 经 `escapeContractTags`） |
| `src/lib/orchestrator/prompts.ts` | `ORCHESTRATOR_DECISION_PROMPT` 改为短 JSON-only prompt，只保留 action 枚举、规则、单条 JSON 示例 |
| `tests/opencode-adapter.test.ts` | 断言无 `--dir`、含 `--standalone` |
| `tests/orchestrator-agent.test.ts` | provider 前缀 model 不落 CC-Switch；非前缀仍兜底 |
| `tests/orchestrator-extended.test.ts` | `rawSystemPrompt` 绕过包装；决策缺字段容错；任务 prompt 含产出格式 |

## 验证

- `npm test`：161 files / 1689 passed / 3 skipped
- `npm run build`：通过
- 3 次 golden path：run1 `9c8203fb...`、run2 `fc628784...`、run3 `e7b5e21f...`，均 3/3 + 系统校验 completed
- 决策实测返回合法 `align_confirm` / `align_decompose` / `execute`

## 教训

- CLI 升级后先跑一个最小 `opencode run --format json` 冒烟，不要假设旧参数仍有效。
- “system prompt 不生效”优先检查 `--agent` 是否真的传了；没有 `id` 就没有 agent 文件。
- 动态 agent + 后台服务 = 必须 `--standalone`，否则缓存会让新文件永远找不到。
- 结构化调用不要复用聊天人格包装；短 JSON-only prompt 比长角色 prompt 更可靠。
- 项目内工作目录会注入 `AGENTS.md`，决策/结构化调用应使用独立临时目录。

## 相关文件

- `CLAUDE.md`「OpenCode CLI 兼容性」「UX 身份与权限不变量」
- `AGENTS.md`「OpenCode CLI 兼容性（2026-11）」
- `docs/TODO-ux.md` U13「U13 发现的真实阻塞」
- `docs/demo-3min.md`

# Orchestrator 平台统一改造方案

> 创建时间: 2026-05-26 | 状态: ✅已实施 (2026-05-27)

## 背景

当前 Orchestrator 独立使用 `platform: 'llm'` adapter 直接调 API，与子 Agent 的 CLI adapter 路径不同。这带来几个问题：

1. LLM adapter 需处理 OpenAI/Anthropic 两种 API 格式，baseUrl 补 `/v1`、判断 `/anthropic` 等逻辑复杂易出错
2. DeepSeek 的 Anthropic 格式 baseUrl 导致连接失败
3. Orchestrator 的 apiKey/model/baseUrl 存在 AppConfig 表，而子 Agent 存在 Agent 表，两套配置体系不统一
4. 项目定位是 Claude Code / Codex / OpenCode 的可视化协作前端，所有 LLM 调用应通过 CLI 平台完成

## 改动目标

### 1. Orchestrator 做成特殊 Agent 记录

- 在 Agent 表中新增一条 `isOrchestrator: true` 的特殊记录
- Orchestrator 有自己的 `platform`、`model`、`baseUrl`、`apiKey`，和其他 Agent 一样独立配置
- `callLLM` / `callLLMForAnalysis` 从 Orchestrator Agent 记录读取配置，用对应的 CLI adapter 执行
- AppConfig 表中 `orchestrator_apiKey/model/baseUrl` 相关 key 不再使用， Orchestrator 配置统一存 Agent 表

### 2. Orchestrator 自动选择可用 platform

- 优先级：`claude-code` → `opencode` → 其他可用 platform
- 选择逻辑：检测 CLI 是否可用（运行 `claude --version` / `opencode --version`），按优先级取第一个可用的
- 如果没有可用 CLI，Orchestrator 决策失败并返回明确错误信息

### 3. CC-Switch 作为配置来源

- 配置向导的"导入"功能从 `~/.cc-connect/config.toml` 读取
- 导入时自动识别 platform 类型：
  - `agent_types` 含 `claudecode` → `platform: 'claude-code'`
  - `agent_types` 含 `opencode` 或其他 → `platform: 'opencode'`
- 导入后写入对应 Agent 记录（包括 Orchestrator Agent）

### 4. LLM adapter 保留但不使用

- `llm-adapter.ts` 文件保留在代码中，`platform: 'llm'` 类型保留在 types.ts
- Orchestrator 和子 Agent 的执行路径不再使用 `llm` adapter
- Agent 创建时的 platform 默认值从 `'llm'` 改为 `'claude-code'`
- 保留原因：未来可能支持直接 API 调用场景

### 5. 配置向导改为"导入平台配置"

原 3 步向导：
- 步骤1 欢迎页
- 步骤2 配置 LLM（API Key / Model / Base URL / CC-Switch 导入 / 测试连接）
- 步骤3 可选将预设 Agent 改为 llm

改为新 3 步：
- 步骤1 欢迎页：说明项目基于 CLI Agent 平台
- 步骤2 导入平台配置：
  - 自动检测 CC-Switch 中可用的 Agent 平台
  - 显示检测到的平台列表（如"DeepSeek (opencode)"、"Anthropic (claude-code)"）
  - 用户选择哪个作为 Orchestrator 的默认 platform
  - 检测对应 CLI 是否可用（`claude --version` / `opencode --version`）
  - 支持手动指定 platform 和配置
- 步骤3 完成

### 6. 测试连接改为检测 CLI 可用性

- `test-connection` API 从"发 prompt 测试 LLM 响应"改为"检测 CLI 工具是否安装且可运行"
- 检测方式：运行 `claude --version` / `opencode --version`，解析版本号
- 返回结果：`{ available: true, version: 'x.y.z', platform: 'claude-code' }` 或 `{ available: false, error: '未检测到 claude CLI' }`

### 7. 进程常驻模式（未来）

- 当前保持 spawn + kill 模式，每次调用创建新 CLI 进程
- 未来改造为进程常驻模式：spawn 一次，通过 stdin/stdout 持续交互
- 优先级：P2，在多 Agent 协作流畅运行后再做

### 8. 每个 Agent 独立配置（不变）

- Agent 表的 `platform`、`model`、`baseUrl`、`apiKey` 字段保持不变
- 每个 Agent 可独立配置不同的 platform 和模型
- AgentA 用 DeepSeek（便宜），AgentB 用 Claude（强），各自独立

## 涉及文件

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `prisma/schema.prisma` | Agent 表新增 `isOrchestrator Boolean @default(false)` 字段 |
| `src/lib/orchestrator/index.ts` | `callLLM`/`callLLMForAnalysis` 从 Orchestrator Agent 记录读配置，使用 CLI adapter |
| `src/lib/app-config.ts` | 移除 `getOrchestratorConfig()`（不再从 AppConfig 读 Orchestrator 配置） |
| `src/app/api/agents/route.ts` | Agent 创建默认 platform 从 `'llm'` 改为 `'claude-code'` |
| `src/app/api/sessions/[id]/chat/route.ts` | `handleOrchestratorChat` 从 Orchestrator Agent 记录读配置 |
| `src/components/setup-wizard.tsx` | 3 步向导改为：欢迎 → 导入平台配置（CC-Switch + CLI 检测） → 完成 |
| `src/app/api/config/test-connection/route.ts` | 从"测试 LLM 响应"改为"检测 CLI 可用性" |
| `src/app/api/config/import-provider/route.ts` | 导入时自动识别 platform 类型，写入 Orchestrator Agent 记录 |
| `src/app/api/config/orchestrator/route.ts` | 读写 Orchestrator Agent 记录而非 AppConfig |
| `src/app/api/config/route.ts` | 保持通用配置读写，Orchestrator 相关 key 不再使用 |

### 新增文件

| 文件 | 说明 |
|------|------|
| `src/lib/cli-detect.ts` | CLI 可用性检测工具函数（`detectCLIPlatform()`） |
| `src/app/api/config/detect-platform/route.ts` | CLI 可用性检测 API |
| `src/lib/app-config.ts` 新增 `ensureOrchestratorAgent()` | 应用层初始化，首次调用从 AppConfig 迁移到 Agent 记录 |
| `prisma/seed.ts` 新增 Orchestrator Agent | 新数据库场景创建 Orchestrator Agent |

### 不修改文件

| 文件 | 原因 |
|------|------|
| `src/lib/adapter/llm-adapter.ts` | 保留但不再被 Orchestrator/子 Agent 使用 |
| `src/lib/adapter/claude-code-adapter.ts` | 保持不变 |
| `src/lib/adapter/opencode-adapter.ts` | 保持不变 |
| `src/lib/adapter/types.ts` | `platform: 'llm'` 类型保留 |

## 验证标准

1. `npx prisma migrate dev` — 数据库迁移成功（Agent 表新增 isOrchestrator 字段）
2. `npx tsc --noEmit` — 0 类型错误
3. `npx vitest run` — 所有测试通过
4. 首次打开 → 配置向导弹出 → 从 CC-Switch 导入 → 自动识别 platform → CLI 检测通过 → 完成
5. Orchestrator 使用选定的 CLI platform 进行决策 → 不再依赖 `llm` adapter
6. 子 Agent 各自独立配置 → AgentA 用 opencode + deepseek-v4-flash，AgentB 用 claude-code + claude-opus-4-7
7. 没有 CLI 可用时 → Orchestrator 返回明确错误，不静默失败
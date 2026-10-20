# 权限模型 CLI 探针（2026-10-20）

> 目标：在目标 Windows 环境上实测 Claude Code / OpenCode 的“工具可用性”与“审批”语义，
> 为双维度权限模型提供证据。探针不调用真实付费模型：Claude 用本地 mock Anthropic SSE
> （返回 tool_use 后观察 control_request / tool_result），OpenCode 用免费模型 + 临时 workDir。

## 版本

- Claude Code `2.1.270`（`<home>\AppData\Roaming\npm\claude`）
- OpenCode `v2.0.27`（`<home>\.opencode\bin\opencode.exe`）

## Claude Code 实测结论

### 1. `--bare` 会砍掉工具，且 `--tools` 被忽略

同一 mock 对话下读取 `system/init` 的 `tools`：

| 参数 | init tools |
|---|---|
| `--bare`（现状） | `Bash, Edit, Read` |
| `--bare --tools Read,Write,Edit,Bash,Glob,Grep` | `Bash, Edit, Read`（仍只有 3 个） |
| 无 `--bare`，`--tools Read,Write,Edit,Bash,Glob,Grep` | 恰好 6 个 |
| 无 `--bare`，`--tools default` | 全部内置工具（Bash/Edit/Read/Write/Glob/Grep/WebFetch/WebSearch/Task/...） |

**结论**：`--allowedTools` 不是可用性白名单；真正的可用性开关是 `--tools`。现状 `--bare`
只暴露 3 个工具，agent.tools 里的 Write/Glob/Grep 实际不可用。

### 2. provider 配置必须走 `--settings`

- 只设 `CLAUDE_CONFIG_DIR=<临时目录>`（含 `settings.json`）时，mock 端点收不到 `/v1/messages`，
  CLI 仍使用用户级模型/端点；
- 同时传 `--settings <同目录>/settings.json` 后，mock 收到请求，模型为 mock 声明的模型；
- `CLAUDE_CONFIG_DIR` 仍负责 transcript/插件隔离：临时目录下会出现 `projects/*.jsonl`，
  `plugins: []`。

**结论**：`CLAUDE_CONFIG_DIR`（隔离 transcript/插件）+ `--settings`（provider 配置）必须同时传。
加 `--setting-sources user` 可忽略 workDir 的 project/local 设置与 hooks；再用
`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` 关闭 workDir 的 CLAUDE.md 自动发现。

### 3. 审批维度

用 `Edit` / `Bash` 触发权限：

| 参数 | 行为 |
|---|---|
| `--permission-mode default` | stdout 发 `control_request`（`can_use_tool`），等待 `control_response` |
| `--permission-mode default --allowedTools Edit` | Edit 直接放行，无 control_request |
| `--permission-mode default --allowedTools Bash` | Bash 直接放行 |
| `--permission-mode dontAsk` | 自动拒绝，stderr 有 permission denied |
| `--permission-mode acceptEdits` | 自动放行 Edit（文件实际写入） |
| `--permission-mode auto`（`-p` + stdio） | **不可用**：不发 control_request，报 `permission stream closed`/AbortError |
| `--restricted` | 组件可用性/隔离更强，但会忽略 `CLAUDE_CONFIG_DIR` 的 settings，transcript 落到 `~/.claude`，不采用 |

**采用方案**：
- CLI 永远传 `--permission-mode default` + `--permission-prompt-tool stdio`；
- `default` 模式不传 `--allowedTools` → 每次工具调用发 control_request → 前端确认；
- `auto` 模式把可用工具加入 `--allowedTools`，同时 ProcessRegistry 对剩余 control_request
  统一 allow（覆盖 MCP 工具）；
- 可用性由 `--tools <agent.tools>` 控制；空列表传 `--tools default`；
- 不再使用 `--bare`。

## OpenCode 实测结论

### 1. 权限配置只在 agent frontmatter 可靠

- `OPENCODE_CONFIG=<file>` / `OPENCODE_PERMISSION` **不生效**：`opencode debug config`
  不展示该文件，运行时权限也不受控；
- `.opencode/agents/*.md` frontmatter 的 `tools` / `permission` 生效：`opencode debug agents`
  会把它转换成新的 `permissions` ruleset，例如：
  - `permission.bash: deny` → `{action:"shell", resource:"*", effect:"deny"}`
  - `permission.edit: ask` → `{action:"edit", resource:"*", effect:"ask"}`
  - `permission.read: allow` → `{action:"read", resource:"*", effect:"allow"}`
- `read` 使用对象规则保留 `.env` 审批（否则宽泛的 read allow 会覆盖默认 `.env` ask）：
  ```yaml
  permission:
    read:
      "*": allow
      "*.env": ask
      "*.env.*": ask
      "*.env.example": allow
  ```
  `opencode debug agents` 会按顺序追加 `read *.env ask`，最后匹配生效。
- OpenCode v2 默认 agent 的 `permissions` 是 `* allow` + `.env` ask；自定义规则必须放在
  frontmatter 才会追加到规则集。

### 2. `--auto` 与 ask/deny

- `--auto` 文档语义：自动批准未被显式 deny 的请求；`deny` 仍生效。
- headless `opencode run` **没有 TTY 确认协议**：`permission: { bash: "ask" }` 且不传 `--auto` 时，
  stderr 输出 `permission requested: shell (...); auto-rejecting`，工具被拒绝；
- 传 `--auto` 时 ask 被自动批准；
- 旧的 `--dangerously-skip-permissions` 仍作为隐藏别名存在，但语义更宽（可能绕过 deny），
  改用文档化的 `--auto`。

### 3. 工具名变化

OpenCode v2 的模型工具集包含 `execute` 代码执行工具；`bash` 在部分 provider 下不可见。
因此 AgentHub 的 `Bash` 同时授予 OpenCode `bash` 与 `execute`，避免“允许 Bash 但实际无
shell 工具”的能力丢失；`Execute` 也可单独作为工具名。

**采用方案**：
- 在 `.opencode/agents/agenthub-*.md` frontmatter 写 `tools`（可用性）与 `permission`
  （ask/allow/deny）；
- 删除 ProcessRegistry 的 `OPENCODE_CONFIG` 临时文件与 `OPENCODE_PERMISSION` env（死通道）；
- `auto` 传 `--auto`；`default` 不传；
- **default 模式在 headless 下只能实现“只读”**：read/glob/grep/list/todowrite allow，
  edit/bash/execute/web/task/question ask（CLI 自动拒绝）。需要写操作请切 auto。

## 残余风险

1. OpenCode default 模式无法交互确认，只能只读；这是 CLI headless 限制，不是 AgentHub UI 缺失。
2. `--settings` 路径若包含空格会被 `assertSpawnSafe` 拒绝（与现有 workDir/MCP 临时路径限制一致）。
3. 共享 projectDir 的外部并发修改仍可能进入审计 diff（worktree 隔离未启用）。
4. `--auto` 对 `ask` 的自动批准依赖 OpenCode 版本语义；升级 CLI 需重跑本探针。

## 复现命令（脱敏）

```powershell
# Claude：本地 mock Anthropic，观察 init tools / control_request
$env:CLAUDE_CONFIG_DIR = '<temp>'
$env:CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1'
claude -p 'run echo probe' --output-format stream-json --input-format stream-json --verbose `
  --permission-prompt-tool stdio --settings '<temp>\settings.json' `
  --setting-sources user --permission-mode default `
  --tools 'Read,Write,Edit,Bash,Glob,Grep'
```

```powershell
# OpenCode：frontmatter permission + --auto 行为
opencode run --format json --model opencode/mimo-v2.6-flash-free --auto 'Use bash to echo hello'
opencode debug agents   # 检查 permissions ruleset
```

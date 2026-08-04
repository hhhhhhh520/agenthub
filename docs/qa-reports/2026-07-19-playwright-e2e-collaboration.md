# Playwright E2E 协作流程测试报告
> 测试日期: 2026-07-19 | 测试环境: localhost:3000 | 浏览器: Chromium (Playwright MCP)

## 测试概览

| 任务类型 | 任务描述 | 结果 | 耗时 |
|----------|----------|------|------|
| 简单任务 | 创建 hello.txt 写入 "Hello World" | ✅ 成功 | ~30s |
| 复杂任务 | Python 贪吃蛇游戏（pygame） | ⚠️ 部分成功 | ~5min（超时失败） |

## 测试 1：简单任务 — 创建 hello.txt

### 协作流程

```
用户输入 → Orchestrator 决策("简单文件创建任务，直接委派执行") → 前端工程师执行
  → pwd 确认目录 → PowerShell 命令失败 → 自动切换 bash echo → 文件创建成功
```

### 流程评价

| 环节 | 表现 | 评分 |
|------|------|------|
| Orchestrator 路由 | 正确识别简单任务，直接委派 | ✅ |
| Agent 选择 | 分配给"前端工程师"（非最优但可接受） | ⚠️ |
| 自我纠错 | PowerShell 失败后自动切换 bash | ✅ |
| 执行报告 | 产出物位置、验证方式、遗留问题清晰 | ✅ |
| 权限控制 | 每次 Bash 操作需用户批准 | ✅ |

### 产出物验证

- 文件路径：`D:/ai全栈挑战赛/agenthub/hello.txt`
- 文件内容：`Hello World` ✅
- 文件大小：12 字节 ✅

---

## 测试 2：复杂任务 — Python 贪吃蛇游戏

### 协作流程

```
用户输入 → Orchestrator 决策("需求明确，Python游戏开发任务直接委派后端工程师")
  → 后端工程师执行 → 检查 Python 版本(3.12.10) → 生成 pygame 版本(212行)
  → 检查 pygame 未安装 → 请求 pip install(3次，每次需批准)
  → 决定降级到 tkinter → 重写过程中进程超时(60s无数据) → 任务失败
```

### 流程评价

| 环节 | 表现 | 评分 |
|------|------|------|
| Orchestrator 路由 | 正确选择"后端工程师"执行 Python 游戏 | ✅ |
| 环境检测 | 先检查 Python 版本，再检查 pygame | ✅ |
| 代码生成 | 212 行完整 pygame 实现，结构清晰 | ✅ |
| 依赖处理 | 反复尝试 pip install（3次），降级决策太慢 | ❌ |
| 错误恢复 | 最终超时失败，未能完成 tkinter 重写 | ❌ |

### 产出物评估（pygame 版本，212 行）

- ✅ Snake / Food / Game 三类结构完整
- ✅ 方向键控制 + 防掉头逻辑
- ✅ 碰撞检测（撞墙 + 撞自己）
- ✅ 分数显示 + 游戏结束提示
- ✅ 空格重开 + ESC 退出
- ✅ Python 语法检查通过

### 最终状态

```
Orchestrator: "Process failed after 4 attempts: No data received for 60s, process appears stalled."
Orchestrator: "处理消息时出错，请稍后重试"
```

---

## 发现的问题

### ISSUE-006：依赖安装循环

**现象**：Agent 反复尝试 `pip install pygame`（3次），每次都需要用户批准。

**根因**：`process-registry.ts:705` — permissionMode 为 `'default'` 时，每次工具调用都触发权限审批。系统没有"同类操作批准缓存"机制。`execution.ts:400` 的监控审查已用 `permissionMode: 'auto'`，但实际任务 Agent 仍用 `'default'`，设计不一致。

**相关代码**：
- `src/lib/services/execution.ts:214-218` — permissionMode 传递
- `src/lib/adapter/process-registry.ts:700-748` — 权限请求处理

---

### ISSUE-007：进程超时阈值过短

**现象**：后端工程师在重写 tkinter 版本时，60 秒无数据输出被判定为 stalled，进程被杀。

**根因**：`process-registry.ts:73` — `NO_DATA_TIMEOUT_MS = 60 * 1000`。LLM 思考阶段、大文件读写期间不产生 stdout 输出，60 秒对复杂代码生成过于激进。外层 `timeout.ts:68` 已有 15 分钟总超时。

**相关代码**：
- `src/lib/adapter/process-registry.ts:73` — 常量定义
- `src/lib/adapter/process-registry.ts:848-854` — 超时检测逻辑

---

### ISSUE-008：任务完成后无自动测试触发

**现象**：复杂任务完成后，系统没有自动触发测试工程师验证产出物。

**根因**：
1. `execution.ts:479-493` — 执行引擎"任务全部完成即结束"，无测试阶段
2. `prompts.ts:42-94` — Orchestrator 的 8 种 action 中无 `test/verify` 动作
3. `index.ts:35` — AGENT_BEHAVIOR_RULES 中"代码修改后运行测试"仅为 LLM 软提示，非系统级强制

**相关代码**：
- `src/lib/services/execution.ts:479-493` — 执行循环结束逻辑
- `src/lib/orchestrator/prompts.ts:42-94` — Orchestrator 决策 prompt

---

### ISSUE-009：Agent 角色匹配偏差

**现象**：简单文件创建任务分配给"前端工程师"，而非更通用的角色。

**根因**：`prompts.ts:86` 的示例将"简单修改"锚定到"前端工程师"：
```
用户: "把按钮颜色改成蓝色"
→ {"action":"delegate","target":"前端工程师",...}
```
`TASK_DECOMPOSITION_PROMPT` 缺乏角色匹配规则，Agent 的 `expertise` 字段未被充分利用。`index.ts:352` 的 fallback 按索引轮询分配。

**相关代码**：
- `src/lib/orchestrator/prompts.ts:86` — 决策 prompt 示例
- `src/lib/orchestrator/prompts.ts:120-151` — 任务拆解 prompt
- `src/lib/orchestrator/index.ts:352` — fallback 分配逻辑

---

## 总体评价

| 维度 | 评分 | 说明 |
|------|------|------|
| 协作流程合理性 | ⭐⭐⭐⭐ (4/5) | Orchestrator 路由准确，Agent 有自我纠错能力 |
| 实际产出物质量 | ⭐⭐⭐⭐ (4/5) | 简单任务完美，复杂任务代码结构清晰但因环境限制未完成 |
| 系统健壮性 | ⭐⭐⭐ (3/5) | 超时有错误提示，但依赖处理和降级机制需优化 |

## 改进建议

| 优先级 | 问题 | 修复方向 |
|--------|------|----------|
| 🔴 P0 | 进程超时 | 增大 `NO_DATA_TIMEOUT_MS` 至 180-300 秒 |
| 🟡 P1 | 角色匹配 | 修改 prompt 示例 + 增加角色匹配规则 |
| 🟡 P1 | 权限缓存 | 增加"同会话同类操作自动放行"机制 |
| 🟢 P2 | 自动测试 | 执行引擎增加测试阶段 + Orchestrator 增加 verify action |

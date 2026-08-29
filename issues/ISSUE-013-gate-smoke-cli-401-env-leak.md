# Gate 冒烟 CLI 子进程 401：交互式会话代理 env 经 process.env 泄漏进实验子进程

> 创建时间: 2026-08-28 | 状态: 🟢已解决

## 问题描述

P9-乙 Gate 冒烟（on-seqgate+verify × A ×5，讯飞 xopdeepseekv4flash0731）第一 run 耗时 1084s，结果 `defect`：
- decisionTrace 空、tasks=0、phase 恒 idle、6 轮全为 self 罐头循环（noProgress break）
- CLI 子进程会话 jsonl 中 assistant 全部 `model:"<synthetic>"`、usage 全 0、内容 `Failed to authenticate. API Error: 401 HMAC signature cannot be verified: apikey not found`
- 每轮决策固定耗时 ~180s（401 重试至内部超时）

同一时间同机 curl/fetch 直连讯飞端点：200 OK、~2s 正常返回——**端点与 key 都没问题，坏的只是 CLI 子进程路径**。

## 出现原因

完整证据链（全部实测，非推断）：

1. 用户交互式 Claude Code 会话经本地 qwen 代理运行，`~/.claude/settings.json` 的 `env` 块定义 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL=127.0.0.1:15721`、`ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_*_MODEL(_NAME)=qwen3.8-max` 等；这些变量进入会话进程环境。
2. 从该会话的终端发射实验启动链（Bash → PowerShell 发射器 → cmd → npx vitest）时**逐层继承**这些变量。
3. `process-registry.ts:349-351` spawn CLI 的 env 构造为 `{...process.env, ...providerEnv}`，而 `providerEnv` 只覆盖 `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`（来自 DB agent 配置，:330-332）——**`ANTHROPIC_AUTH_TOKEN` 等未被覆盖，原样漏进 CLI 子进程**。
4. echo 服务抓包实证（Run B）：CLI 同时发出 `x-api-key: <讯飞key>` 与 `authorization: Bearer <代理token>`。
5. curl 复刻该头组合直连讯飞：返回 **401 "HMAC signature cannot be verified: apikey not found"，与冒烟错误逐字一致**——讯飞优先校验 Bearer，代理 token 在讯飞侧不存在。
6. CLI 401 后重试 ~180s 放弃，把错误文本作为合成响应（model=`<synthetic>`）返回 → 决策层把「Failed to authenticate...」当模型输出 → 拿不到合法 action → self 兜底循环 → 6 轮 noProgress break → `defect`。

为何 P8 未现：P8 发射环境的进程树上没有这套代理 env（settings env 块系后续配置）。**结论：实验可复现性依赖发射环境干净度——此前靠"换机器/换会话"运气保证，从未被工程化。**

## 解决方案

harness 自清洗（不依赖发射环境）：`experiments/p5/setup.ts` 新增 `scrubInheritedProviderEnv()`，`setupExperiment()` 入口（先于 F3 断言）清除 `process.env` 中所有 `ANTHROPIC_` 前缀、`CLAUDE_` 前缀（唯一豁免 `CLAUDE_CONFIG_DIR`，F3 隔离目录本体）及 `CLAUDECODE` 精确匹配，返回被清键名并回显日志。

安全性：harness 正主凭据走 `GLM_* env → DB agent → providerEnv 逐次注入`，与被清的 `process.env.ANTHROPIC_*` 完全解耦，不受影响。

针对性测试（`setup.test.ts`，TDD）：
- 清洗范围：污染集逐项删除、CLAUDE_CONFIG_DIR/GLM_* 保留、幂等
- 接线顺序：非法 CLAUDE_CONFIG_DIR 下 setupExperiment throw 时 AUTH_TOKEN 必须已被清（顺序反了即红）

## 相关文件

- `experiments/p5/setup.ts`（scrubInheritedProviderEnv + setupExperiment 接线）
- `experiments/p5/setup.test.ts`（T5-1 describe）
- `src/lib/adapter/process-registry.ts:330-351`（泄漏机制所在，生产侧未改动——见遗留）

## 参考资料

- 全局规则「测试禁硬编码API密钥」「LLM 返回值不能裸用」同源教训：外部注入的 env 会改变子进程行为，边界处必须显式声明而非继承默认
- **遗留项**：process-registry 的 `{...process.env}` spread 是生产面同类泄漏的通用形态（如平台自身子 agent 场景）。本 ISSUE 只修 harness 侧；生产侧是否收敛 provider env 继承面，留 P10 讨论。

# AgentHub 多 Agent 讨论/聊天全灭 — claude CLI 无视 spawn env 的 ANTHROPIC_BASE_URL（env 通道死亡）
> 创建时间: 2026-09-28 | 状态: 🟡排查中（修复 commit 1/2 落地中，待端到端冒烟）

## 问题描述

2026-09-27 用户盲测验收（roadmap §4.1）的讨论会话（959475c9）四+角色全部同模式阵亡：
每个角色 spawn CLI 后 stderr 打印 `[claude-code:unrecognized_model]`（噪音），整轮无 stdout，
3 分钟讨论预算超时被杀 → opinion 记为「[X 讨论超时，已跳过]」。7 角色 × 3 次适配器重试 × 3min
预算 ≈ 65 分钟后 discussion summary 出来全是「已跳过」。

同期聊天路径（会话 1d7c8d87「有人吗」）HTTP 200 in 6min22s，但"回答"是 CLI 的 401 错误文本
`Failed to authenticate. API Error: 401 The API key format is incorrect. Request id: 0217...`——
**同一个 401 两种死相**：15min 预算的路径活到 CLI 放弃（错误文本被当回复消费），3min 预算的
路径只见"超时"。

库里同款 401 最早出现在 **2026-06-24/25**（会话 a1332c38）——多 agent LLM 通路至少从 6 月起
就没有真正通过。

## 根因（2026-09-28 八组活体实验定案，推翻初判）

**初判（另一分析 agent）「sk-sp- 讯飞钥匙插阿里云锁」被探针推翻**：
- sk-sp- key 在 token-plan.cn-beijing.maas.aliyuncs.com **认证通过**（403 `AccessDenied.Unpurchased` =
  模型未开通，非鉴权失败）；xfyun 端点拒收该 key（`HMAC signature cannot be verified`）→ key 归属
  aliyun，配对没错。
- aliyuncs 自己的 401 指纹是 `InvalidApiKey` + UUID request_id——库里 401 是
  `AuthenticationError` + `0217...` request id（火山系错误 schema），**根本不是这个端点发的**。

**真根因（测试 A-H/控制组链）**：claude.exe v2.1.270 `-p` 模式**完全无视进程 env 的
`ANTHROPIC_BASE_URL`**（把 env BASE_URL 指向本地 127.0.0.1 HTTP 服务器 → 零请求命中；
清空全部 ANTHROPIC_*/CLAUDE_* env + 干净 CLAUDE_CONFIG_DIR + 编造模型名 → 请求照样落到
同一个火山系端点）。子 CLI 实际命中用户级 `~/.claude/settings.json` env 块声明的 ark 端点，
携带 spawn env 注入的 `ANTHROPIC_API_KEY=sk-sp-...` 被 ark 拒「The API key format is incorrect」。
env 注入通道（process-registry providerEnv）对 claude 路由**整体失效**。

**唯一有效通道**：`CLAUDE_CONFIG_DIR` 下的 settings.json `env` 块（p5 装置 40/40 有效 run
先例；控制实验 F/F2：受管 settings 分别抵达 aliyuncs/xfyun 拿到各自协议级指纹）。

### 附带结论（修订 ISSUE-026）
- 未知模型名在 v2.1.270 **不再本地硬拒**：编造模型名也 unrecognized_model 警告 + 照发请求。
- `model=<synthetic>` ≠「请求未发出」：服务器 401/403 同样被包装成同款 synthetic
  "There's an issue with the selected model"（快速失败 exit 1，不记 api_error 行）。
  ISSUE-026「CLI 本地拒跑」的定性需按此修订。
- CLI 对 401 内部重试 ~10 次 / ~3 分钟（指数退避 maxRetries=10）；adapter 层
  MAX_SEND_RETRIES=3 叠加 → 聊天路径 ~6.4min。

### tokenrhythm 换线能力地图（2026-09-28 全量探针）
Anthropic 协议（/v1/messages，Bearer）：**支持** = deepseek-v4-pro-0813、glm-5.1、glm-5.2、
glm-5.3-flashx、minimax-m2.7、kimi-k2.6、mimo-v2.5-pro、mimo-v2.6-pro、mimo-v2.6-flash、
deepseek-flash；**不支持** = qwen 全系（3.7/3.8）、glm-5.3/5.3-flash、kimi-k2.7-code/k3、
seed 系、longcat。**用户拍板：mimo-v2.6-flash**。⚠️ baseUrl 必须是不带 /v1 的根
（CLI 自行追加 /v1/messages）。

## 解决方案（用户批准 + 双审查后落地）

1. **Commit 1（根治）**：provider 配置改走受管 `CLAUDE_CONFIG_DIR` settings.json 通道。
   新模块 `src/lib/adapter/claude-code-env.ts`：`~/.agenthub/claude-cfg/<sha256(baseUrl+apiKey+model)[:12]>/settings.json`
   （env: BASE_URL/AUTH_TOKEN/MODEL/SMALL_FAST_MODEL；0o700/0o600；读同跳过写+EPERM 容忍原子写）；
   registry `composeSpawnEnv` + `envScrub`（ANTHROPIC_*/CLAUDE_ 前缀剥除后按受管配置重建，
   Windows 大小写不敏感比对）；adapter send() 接线；sweep 出清（12-hex 形态 + `.agenthub-managed`
   哨兵双护栏；active 目录内 >1h 残留 tmp 出清）挂两个触发点——GET /api/agents 全量视图 +
   启动兜底（src/instrumentation.ts，active 集合 = Agent 表 + orchestrator fallback 并集，
   数据源失败整体跳过，helper `src/lib/services/claude-cfg-maintenance.ts`）；baseUrl scheme
   校验（https 或 http 回环，防明文凭据外发）。
   另含 resume 降级：`isSessionNotFoundError` → 丢 sessionId 全新会话重试（换线后存量
   cliSessionId 必撞 resume-not-found）。
   审计整改：pre-commit-audit 三视角（攻击者/生命周期/声明 vs 实现）+ 提交前双审查共
   12 项 findings 全部整改（哨兵、scheme、tmp 残留三路径、启动兜底、大小写、12-hex 用例
   空集合失效、注释锚点失实、测试泄漏）。
2. **Commit 2（止损+透传）**：isPermanentError 补认证/模型签名（含 transient-401 变
   「立即死」的取舍说明）；`looksLikeCliSyntheticError`（前缀+<300 长度上限防误伤）接进
   orchestrator 错误消费路径；runDiscussion skipMsg 携带真实错误文本。
3. **换线**：8 个带 key 的 agent 整体切 tokenrhythm + mimo-v2.6-flash（key 经 DB，不落文档）。
4. **用户侧**：aliyun token-plan 的 qwen3.8-max-preview/flash 均 403 Unpurchased（与讯飞比赛
   09-05 同款），不开通则该线路不可用——已用换线绕开。

## 遗留（评审明示不阻塞）
- `ensureClaudeConfigDir` 的 rename-EPERM 容忍分支无自动化用例（同步函数单线程 Promise.all
  测不到竞态；为此注入 io 会扭曲产线签名）——靠三段条件推演 + 真实并发首启场景守护。
- PATCH /api/agents/[id] 允许 baseUrl 与 apiKey 分开改（providerRef 语义）——本批以 scheme
  校验收敛明文外发面；「改 URL 必须重验 providerRef」属 API 语义变更，留待后续批。
- env 通道对 opencode 仍有效，providerEnv 注入保留（防误删，composeSpawnEnv 注释已声明）。
- 主库 24 会话 decisionTrace 全 '[]' 为预期（老会话早于 trace 功能）；盲测验收待本修复
  + 换线冒烟通过后重跑。

## 相关文件
- `src/lib/adapter/claude-code-env.ts`（新）、`process-registry.ts`、`claude-code-adapter.ts`、
  `src/app/api/agents/route.ts`、`src/lib/services/claude-cfg-maintenance.ts`（新）、
  `src/instrumentation.ts`
- 测试：`tests/claude-code-env.test.ts`、`tests/claude-code-env-wiring.test.ts`、
  `tests/claude-code-adapter.test.ts`、`tests/api-safety.test.ts`、
  `tests/multi-platform-integration.test.ts`、`tests/process-registry-graceful-kill.test.ts`
- 交叉：`issues/ISSUE-026`（根因段修订注记）、memory `claude-cli-model-catalog-reject`（已修订）、
  `feedback_llm_endpoint_default`（tokenrhythm Anthropic 面模型清单）

## 参考资料
- memory：`claude-cli-model-catalog-reject`（v2.1.270 行为矩阵，2026-09-28 修订版）
- p5 先例：`experiments/p5/setup.ts scrubInheritedProviderEnv`（ISSUE-013）、`.claude-cfg` 通道

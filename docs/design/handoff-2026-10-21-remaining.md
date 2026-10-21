# P3 剩余 7 项一次性修复交接（2026-10-21）

> 代码 HEAD: `2a71253` | 文档 HEAD: 本次交接提交 | 分支: master
> 回归基线: `138 files / 1535 passed / 3 skipped`；`next build` 通过；工作区 clean；未 push
> 权威待办: `docs/design/repair-backlog-2026-10-20.md`
> **范围：#29、#30、#31、#32、#33、#34、#36。不要动 #3（已接受风险）。**
> 目标：下一段对话一次性修完这 7 项。

## 0. 必读 / 约束

先读：
- `AGENTS.md`
- `CLAUDE.md`「CI 门禁」「工作区与权限模式」「Chat API Session Lock」
- `docs/design/repair-backlog-2026-10-20.md`
- 本文件

硬约束：
- 每项先写失败回归，再修复，再做变异验证。
- 不改 `prisma/schema.prisma`。
- **#31 是本轮唯一允许修改的 migration**：只改 `prisma/migrations/20260521093512_v2_schema/migration.sql`；不得对 `dev.db` 跑 `migrate reset`/`migrate dev`，测试用临时 SQLite 文件。
- 不 push、不合并。
- 保留：phase 只经 `transitionPhase`、API key 不出站、Contract v1、session lock、附件 SVG 安全下载、临时配置清理。
- UI/文档项没有 DOM 测试环境时，可用纯函数测试 + 源码接线守卫；不要为了测试引入大型前端测试依赖。

## 1. #29 MCP read_messages 读最新 50 条

位置：`src/mcp-server/index.ts:125-129`，`src/mcp-server/message-channel.ts`，`tests/mcp-message-channel.test.ts`。

现状：
```ts
const messages = await prisma.message.findMany({
  where,
  orderBy: { createdAt: 'asc' },
  take: 50,
})
```
当前语义是“最旧 50 条”。长会话中最新消息永远读不到。

期望：
- 查询 `orderBy: { createdAt: 'desc' }, take: 50`；
- 映射前 `messages.reverse()`，输出仍按时间正序；
- `since` 过滤保持；
- 最好把 query 形状抽到 `message-channel.ts` 的纯函数（如 `buildChannelQuery(sessionId, since)`），测试锁定 `orderBy desc + take 50`，并保留 `buildChannelWhere` 现有测试。

测试/变异：
- 新增纯函数测试：query 是 desc + take 50；
- 变异回 asc → 测试红；
- 可加源码守卫确认 handler 使用该 query builder。

## 2. #30 seed 失败设置 exitCode

位置：`prisma/seed.ts:140-142`。

现状：
```ts
main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
```
失败仍以 0 退出，CI/脚本会把 seed 失败当成功。

期望：
```ts
main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
```
- 不要直接 `process.exit(1)` 抢在 disconnect 前；
- 可把 main 注入依赖/导出测试入口，单测模拟 reject 后断言 `process.exitCode=1`；
- 变异：删除 `process.exitCode=1` → 测试红。

## 3. #31 v2 migration 对已有数据失败

位置：`prisma/migrations/20260519080108_init/migration.sql`、`prisma/migrations/20260521093512_v2_schema/migration.sql`。

根因：
- 旧 `Message` 列是 `content TEXT NOT NULL`；v2 `new_Message.rawContent TEXT NOT NULL`，但 INSERT 没提供 `rawContent`：
  ```sql
  INSERT INTO "new_Message" (...) SELECT ... FROM "Message";
  ```
- 旧 `Task` 没有 `updatedAt`；v2 `new_Task.updatedAt DATETIME NOT NULL`，INSERT 也没提供：
  ```sql
  INSERT INTO "new_Task" (...) SELECT ... FROM "Task";
  ```
非空库执行 migrate 会因 NOT NULL 失败。

期望：
- v2 migration 的 Message INSERT 增加 `rawContent`，值取旧 `content`（可用 `COALESCE("content", '')`）；
- Task INSERT 增加 `updatedAt`，值用 `CURRENT_TIMESTAMP`（或旧数据没有该列时直接常量）；
- 不改变 fresh DB 的最终 schema；
- 不修改 `schema.prisma`。

测试：
- 新增 `tests/migration-v2-backfill.test.ts`，使用 `@libsql/client` 创建临时 DB：
  1. 执行 init migration SQL；
  2. 插入 Session/Agent/Task/Message（Task 旧表无 updatedAt，Message 用 content）；
  3. 执行 v2 migration SQL；
  4. 断言 `Message.rawContent` 等于旧 content，`Task.updatedAt` 非空；
  5. 删除临时 DB。
- 变异：删掉 backfill 列 → 测试精确红。
- 只测 v2，不要求全历史迁移链；不要碰 `dev.db`。

## 4. #32 P5 实验路径与 metrics 清理

位置：
- `experiments/p5/config.ts:52-54` 写死 `<workspace>/agenthub/...`
- `experiments/p5/run.test.ts` 多处 `beforeAll` 直接 `rmSync(CONFIG.resultsDir/metrics.jsonl)`
- `experiments/p5/README.md`

期望：
- 路径从项目根派生，不写死盘符：
  ```ts
  const root = resolve(import.meta.dirname, '../..') // 或等价
  dbPath: `file:${resolve(root, 'experiments/p5/p5.db')}`
  ```
- 支持 env 覆盖：`P5_DB_PATH`、`P5_WORK_DIR`、`P5_RESULTS_DIR`（或同类命名），测试用临时目录。
- 测试不再删除仓库内真实 `results/metrics.jsonl`；改为 beforeAll 指向临时 results dir。
- `experiments/p5/README.md` 补“直接运行”配置说明：`GLM_API_KEY`、`GLM_MODEL`、`GLM_BASE_URL`、P5 目录覆盖、`MONITOR_AB=1`。
- 新增 config 单测：默认路径在仓库内、无 `D:/`；env 覆盖生效。
- 变异：把路径改回绝对盘符 → 测试红。

## 5. #33 CI 跑 coverage

位置：`.github/workflows/ci.yml`、`package.json`、`README.md`、`docs/design/roadmap-to-excellence.md`。

现状：
- `package.json` `test` = `vitest run --coverage`；
- CI test job 只跑 `npx vitest run`，阈值未生效。

期望：
- CI test job 改为 `npm test`（或 `npx vitest run --coverage`），确保 `vitest.config.ts` 阈值生效；
- 先本地跑 `npm test` 确认全绿（若 coverage 阈值当前不达标，先查明是阈值/排除配置问题，不得降低覆盖率来过关）；
- 文档更新：README/roadmap 的“CI 只跑 vitest run，不跑 coverage”改为实际状态。
- 可加一个源码守卫测试断言 workflow 含 `--coverage`/`npm test`；但不要只做源码守卫。

## 6. #34 README / roadmap 文档核对

位置：`README.md`、`docs/design/roadmap-to-excellence.md`、`docs/test-plan-detailed.md`、`playwright.config.ts`、`e2e/`。

核对项：
- Node 要求：README 写 Node.js 20.19+；确认与 Next 16/Prisma 7 实际要求一致，补 `package.json engines` 可选（若加，需同步 README）。
- API 路由数：不要沿用“31 路由”；以 `(Get-ChildItem src/app/api -Recurse -Filter route.ts | Measure-Object).Count` 为准（当前 33）。
- E2E：README 的 Playwright/API contract 命令、skip 条件、`playwright.config.ts` globalSetup、`e2e/` 实际文件要一致；`docs/test-plan-detailed.md` 的 migrate/db push 口径统一为 `db push`。
- 不写历史叙事，直接更新事实表/命令。
- 这是文档项，不需要代码回归；完成后用 grep 清零旧数字/旧命令。

## 7. #36 message-parser CRLF / 真实行号 / metadata '='

位置：`src/lib/message-parser.ts`、`tests/message-parser.test.ts`。

三个缺陷：
1. code fence 正则只匹配 `\n`：`/```(\w*)\n.../`，CRLF 输入失败；改为 `\r?\n`，并考虑 closing fence 前 `\r`。
2. `lineStart` 当前是代码块计数器（`lineOffset++`），不是真实行号；应从 match index 计算：
   - 统计 match 起点之前的换行数 + 1（明确 1-based 还是 0-based，先看 `lineStart` 消费方；若无人消费，选 1-based 并测试）。
3. artifact metadata 用 `pair.split('=')`，值里含 `=` 被截断；改为 `indexOf('=')` 只切第一个等号，保留剩余值。

测试：
- CRLF code block 能解析；
- `lineStart` 等于代码块在原文中的真实起始行；
- `<!-- artifact:link href=https://x?a=b title=A=B -->` 的 href/title 完整；
- 变异：恢复 `\n` 正则、`split('=')`、计数器 → 对应用例红。

## 8. 验收与交付

每项完成后：
- 定向测试先红后绿；
- 至少一次变异红；
- 更新 `PROGRESS.md`、`docs/design/repair-backlog-2026-10-20.md`、`docs/design/roadmap-to-excellence.md`、`docs/design/handoff-2026-10-19-batch0.md`；
- 每项独立 commit 或按 #29/#30、#31、#32、#33/#34、#36 小批 commit；
- 最终跑：
  ```powershell
  npx vitest run
  npx next build
  npx eslint <changed-files>
  ```
- 最终基线写实际值；P3 剩余从 8 → 1（仅 #3 接受风险）。
- 不要 push。

## 9. 建议顺序

1. #29（最小，先拿一胜）
2. #30（最小）
3. #36（纯函数，测试容易）
4. #31（migration + 临时 SQLite）
5. #32（实验路径/README）
6. #33（coverage，可能最慢）
7. #34（文档收尾）

如果 #33 coverage 暴露大量存量未覆盖，不要降低阈值或删除测试；先记录真实失败项，必要时把 CI 改成“先跑 coverage、失败可见但不阻塞”需用户确认。默认按“阈值必须过”处理。

# Claude Code CLI adapter 进程残留 + 中文编码问题

> 创建时间: 2026-05-19 | 状态: 🟢已解决

## 问题描述

使用 ClaudeCodeAdapter 调用 CLI 时，出现以下症状：
1. CLI 调用卡住，30秒超时无响应
2. 系统中残留多个 hung 的 claude 进程（每个占用 400MB+ 内存）
3. 累积多个 hung 进程后，导致内存不足，当前会话被系统强制终止
4. 中文字符传递给 CLI 后变成乱码（如 "你好" → "���"）

## 出现原因

1. **`--dangerously-skip-permissions` 标志**：该标志让 CLI 跳过交互式权限确认，但可能导致 CLI 进入异常等待状态
2. **进程清理不完整**：`close()` 方法只调用 `this.process.kill('SIGTERM')` 杀掉主进程，但 CLI 可能启动了子进程，这些子进程残留后持续占用内存
3. **缺乏 stderr 监听**：错误信息被静默忽略，无法定位问题
4. **Windows shell 编码问题**：`shell: true` 模式下，stdin.write 使用系统默认编码（GBK），而非 UTF-8

## 解决方案

1. **移除危险标志**：从 args 中移除 `--dangerously-skip-permissions`
2. **添加进程树清理**：新增 `killProcessTree()` 方法
   - Windows: 使用 `taskkill /pid <PID> /T /F` 杀掉整个进程树
   - Unix: 使用 `process.kill(-pid, 'SIGTERM')` 杀掉进程组
3. **添加 stderr 监听**：捕获错误信息用于调试
4. **缩短超时时间**：从 5 分钟改为 3 分钟
5. **修复中文编码（stdin）**：使用 `Buffer.from(fullPrompt, 'utf-8')` 确保 UTF-8 编码
6. **修复中文编码（stdout）**：Windows 上 `shell: true` 默认使用 GBK 编码，通过 `chcp 65001 >nul && claude` 强制切换到 UTF-8 代码页
7. **任务匹配容错**：编排器 `executeTaskBatch()` 增加 fallback，Agent 名称匹配失败时按任务索引分配

## 相关文件

- `agenthub/src/lib/adapter/claude-code-adapter.ts`

## 测试验证

- 进程清理测试：`echo "回复一个字：好" | timeout 30 claude --output-format stream-json --verbose --bare` → 2.165 秒正常响应
- 中文编码测试：agenthub chat API 发送 "你好" → agent 正确显示并回复中文

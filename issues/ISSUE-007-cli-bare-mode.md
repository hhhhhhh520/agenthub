# Claude Code CLI --bare 模式
> 创建时间: 2026-05-19 | 状态: 🟢已解决

## 问题描述
Claude Code CLI 在非 `--bare` 模式下会加载 Hook、插件、技能等，导致输出中混入大量系统事件（hook_started、hook_response 等），增加了不必要的开销和延迟。

## 出现原因
CLI 默认会执行 SessionStart Hook、加载插件、同步 LSP 等，这些在作为 API 调用时是不需要的。

## 解决方案
使用 `--bare` 标志跳过不必要的初始化：
```bash
claude -p "prompt" --output-format stream-json --verbose --bare
```

`--bare` 跳过：hooks、LSP、plugin sync、attribution、auto-memory、background prefetches、keychain reads、CLAUDE.md auto-discovery。

## 相关文件
- `src/lib/adapter/claude-code-adapter.ts`

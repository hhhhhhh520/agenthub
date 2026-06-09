# Windows 上 spawn('claude') 报 ENOENT
> 创建时间: 2026-05-19 | 状态: 🟢已解决

## 问题描述
在 Windows 上通过 Node.js 的 `spawn('claude', args)` 启动 Claude Code CLI 时报错：`Error: spawn claude ENOENT`。

## 出现原因
`claude` 命令实际是 `claude.cmd`（位于 npm 全局目录）。Node.js 的 `spawn` 在 Windows 上需要 `.cmd` 扩展名或使用 `shell: true`。

## 解决方案
添加 `shell: true` 选项：
```typescript
this.process = spawn('claude', args, {
  shell: true,  // Windows 上必须
  stdio: ['pipe', 'pipe', 'pipe'],
})
```

## 相关文件
- `src/lib/adapter/claude-code-adapter.ts`

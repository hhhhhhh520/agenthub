# Windows 上 spawn 传递中文参数乱码
> 创建时间: 2026-05-19 | 状态: 🟢已解决

## 问题描述
在 Windows 上通过 `spawn('claude', ['-p', prompt], { shell: true })` 传递包含中文的 prompt 时，CLI 收到的是乱码（`���`）。

## 出现原因
Windows 的 shell（cmd.exe）对命令行参数的编码处理与 Node.js 不同。当 `shell: true` 时，参数会经过 shell 解释，中文字符在传递过程中编码丢失。

## 解决方案
使用 stdin 传递 prompt 而不是命令行参数：
```typescript
this.process = spawn('claude', ['--output-format', 'stream-json', '--verbose', '--bare'], {
  shell: true,
  stdio: ['pipe', 'pipe', 'pipe'],
})

// 通过 stdin 传递 prompt
if (this.process.stdin) {
  this.process.stdin.write(task.prompt)
  this.process.stdin.end()
}
```

## 相关文件
- `src/lib/adapter/claude-code-adapter.ts`

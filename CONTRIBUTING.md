# 贡献指南

感谢你对 AgentHub 的关注！以下是参与贡献的基本流程。

## 环境准备

- Node.js 18+
- 至少安装一个 AI CLI 平台：
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)（`npm install -g @anthropic-ai/claude-code`）
  - [OpenCode CLI](https://open-code.ai)（`npm install -g opencode`）

## 开发流程

```bash
# 1. Fork 并克隆仓库
git clone https://github.com/<你的用户名>/agenthub.git
cd agenthub

# 2. 安装依赖
npm install

# 3. 初始化数据库
npx prisma db push

# 4. 填充预设数据
npx tsx prisma/seed.ts

# 5. 启动开发服务器
npm run dev
```

## 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/) 前缀：

| 前缀 | 用途 |
|------|------|
| `feat:` | 新功能 |
| `fix:` | Bug 修复 |
| `chore:` | 维护性改动（存档、清理、文档） |
| `docs:` | 文档更新 |
| `test:` | 测试相关 |

## 测试

```bash
# 运行全部测试
npm test

# 运行 E2E 测试
npm run test:e2e
```

所有测试通过后才能提交 PR。

## 代码风格

- TypeScript strict 模式
- Tailwind CSS 处理样式
- shadcn/ui 组件库
- 不要引入新的 UI 框架

## 提交 PR

1. 从 `master` 创建你的分支（`feat/xxx` 或 `fix/xxx`）
2. 确保 `npm test` 全部通过
3. 确保 `npx next build` 构建成功
4. 写清楚 PR 描述：改了什么、为什么改、怎么测的

# QA Report: AgentHub

> 测试时间: 2026-05-22 | 测试模式: Full | 测试时长: ~15分钟

## 项目概述

**URL**: http://localhost:3000
**框架**: Next.js (检测到 `_next` 路径)
**测试范围**: 全功能测试（桌面端 Web）

---

## 健康评分

| 类别 | 得分 | 权重 | 说明 |
|------|------|------|------|
| Console | 100 | 15% | 无 JS 错误 |
| Links | 100 | 10% | 无明显链接问题 |
| Visual | 90 | 10% | 移动端未开发，桌面端正常 |
| Functional | 85 | 20% | 对话式创建 Agent 失败 |
| UX | 80 | 15% | 删除会话无确认对话框 |
| Performance | 95 | 10% | 响应正常 |
| Content | 100 | 5% | 中文文案完整 |
| Accessibility | 85 | 15% | 有交互元素但部分按钮无文本 |

**综合得分**: 89/100

---

## 发现的问题

### ISSUE-001: 对话式创建 Agent 解析失败 (已记录)

**严重程度**: High | **类别**: Functional

**描述**: 用户发送 "Create a new agent: Python backend engineer, skilled in FastAPI and SQLAlchemy" 时，LLM 返回两个重复的 JSON 代码块，正则只提取第一个导致解析失败。

**证据**:
- 发送消息后 Agents 数量未增加（仍是 7）
- 无错误提示显示在界面
- Console 无错误

**状态**: 已在 `issues/ISSUE-001-agent-creation-parse-failure.md` 详细记录

---

### ISSUE-002: 删除会话无确认对话框

**严重程度**: Medium | **类别**: UX

**描述**: 点击会话旁的 "x" 按钮直接删除会话，无确认对话框。

**证据**:
- 点击 @e2 后 "Full Debug" 会话立即消失
- 会话列表从 "Full Debug" 变为 "Debug Agent Creation"
- 无任何确认提示

**影响**: 用户可能误删重要会话，无法恢复

**建议**: 添加确认对话框或撤销功能

---

### ISSUE-003: 部分按钮缺少文本标签

**严重程度**: Low | **类别**: Accessibility

**描述**: 多个按钮在 ARIA tree 中显示为空文本（如 @e16, @e43-e52 在创建 Agent 对话框中）

**证据**:
```
@e16 [button]
@e43 [button]
@e44 [button]
...
```

**影响**: 屏幕阅读器用户无法识别这些按钮的功能

**建议**: 添加 aria-label 或文本内容

---

## 测试的功能

| 功能 | 状态 | 说明 |
|------|------|------|
| 创建会话（群聊） | ✅ 通过 | 任务描述 → Agent 选择 → 创建成功 |
| 创建会话（私聊） | ✅ 通过 | 点击"私聊"按钮进入私聊模式 |
| 表单式创建 Agent | ✅ 通过 | 名称/技能/提示词填写 → 创建成功，Agents 从 6→7 |
| 对话式创建 Agent | ❌ 失败 | ISSUE-001，解析失败 |
| 编辑 Agent | ✅ 通过 | 对话框显示当前配置，有保存/取消按钮 |
| 导入服务商 | ✅ 通过 | 显示 CC-Switch 配置中的多个服务商 |
| 发送消息 | ✅ 通过 | 消息发送成功，Agent 响应正常 |
| 删除会话 | ✅ 通过 | 直接删除（但无确认，见 ISSUE-002） |
| Tasks 面板 | ✅ 通过 | 显示空状态（0 tasks） |
| Console 错误 | ✅ 通过 | 全程无 JS 错误 |

---

## Top 3 Things to Fix

1. **ISSUE-001**: 对话式创建 Agent 解析失败 - 需修复正则或使用 parseJSON 函数
2. **ISSUE-002**: 删除会话添加确认对话框 - 防止误删
3. **ISSUE-003**: 为无文本按钮添加 aria-label - 提升无障碍体验

---

## Screenshots

保存位置: `.gstack/qa-reports/screenshots/`

- `initial.png` - 首页视图
- `session-chat.png` - 会话聊天视图
- `agents-panel.png` - Agents 面板
- `create-agent-dialog.png` - 创建 Agent 对话框
- `agent-created.png` - Agent 创建成功后
- `conversational-agent-test.png` - 对话式创建测试
- `import-provider-dialog.png` - 导入服务商对话框
- `private-chat-mode.png` - 私聊模式
- `edit-agent-dialog.png` - 编辑 Agent 对话框
- `new-session-dialog.png` - 新会话创建流程

---

## Console Health

**全程无错误**: 所有页面和交互过程中 Console 均无 JS 错误输出

---

## 测试总结

AgentHub 核心功能基本可用：
- 群聊/私聊会话创建流程完整
- 表单式 Agent 创建正常
- 导入服务商功能可用
- 消息发送和响应正常

主要问题：
- 对话式创建 Agent 存在解析 bug（已记录 ISSUE-001）
- 删除操作无确认（UX 风险）
- 部分无障碍问题

**建议**: 优先修复 ISSUE-001，其次添加删除确认对话框
# ESLint 代码质量问题清单
> 创建时间: 2026-05-23 | 状态: 🟢已解决

## 问题概述

运行 `npm run lint` 发现 11 个 ESLint 错误和 19 个警告，主要集中在 React hooks 最佳实践和未使用变量。

---

## 一、React Hooks 错误（严重）

### ISSUE-LINT-001: useEffect 内同步调用 setState

**位置**: `src/components/agent-panel.tsx:57`

**问题**:
```tsx
useEffect(() => {
  loadAgents()  // loadAgents 内部调用 setAgents，导致级联渲染
}, [sessionId])
```

**影响**: 可能导致不必要的重渲染，影响性能

**建议修复**: 将数据获取逻辑移到 useEffect 外部，或使用 useCallback 包装

---

### ISSUE-LINT-002: useEffect 内同步调用多个 setState

**位置**: `src/components/create-agent-dialog.tsx:64`

**问题**:
```tsx
useEffect(() => {
  if (open && editAgent) {
    setName(editAgent.name)
    setExpertise(editAgent.expertise)
    setSystemPrompt(editAgent.systemPrompt || '')
    // ... 多个 setState 调用
  }
}, [open, editAgent])
```

**影响**: 多个同步 setState 触发多次渲染

**建议修复**: 合并为单个状态对象，或使用 useReducer

---

### ISSUE-LINT-003: useEffect 内同步调用 setState

**位置**: `src/components/create-group-dialog.tsx:45`

**问题**:
```tsx
useEffect(() => {
  if (!open) {
    setStep('describe')
    setTaskDesc('')
    // ... 多个 setState
  }
}, [open])
```

**影响**: 同 ISSUE-LINT-002

---

### ISSUE-LINT-004: 函数在声明前被调用

**位置**: `src/components/create-group-dialog.tsx:57`

**问题**:
```tsx
useEffect(() => {
  if (open) {
    fetchRecentDirs()  // 在声明前调用
  }
}, [open])

const fetchRecentDirs = async () => { ... }  // 第 61 行声明
```

**影响**: 闭包捕获旧值，函数更新时不会重新执行

**建议修复**: 将函数声明移到 useEffect 之前，或用 useCallback 包装

---

### ISSUE-LINT-005: useEffect 内同步调用 setLoading

**位置**: `src/components/provider-import-dialog.tsx:30`

**问题**:
```tsx
useEffect(() => {
  if (!open) return
  setLoading(true)  // 同步 setState
  fetch('/api/providers')...
}, [open])
```

**影响**: 同 ISSUE-LINT-001

---

### ISSUE-LINT-006: dynamic 组件缺少 displayName

**位置**: `src/components/code-diff.tsx:8`

**问题**:
```tsx
const MonacoDiff = dynamic(() => import('@monaco-editor/react').then(mod => {
  const { DiffEditor } = mod
  return (props: Record<string, unknown>) => <DiffEditor {...props} />
}), { ssr: false })
```

**影响**: React DevTools 中显示匿名组件，影响调试体验

**建议修复**: 添加 displayName
```tsx
const MonacoDiff = dynamic(...)
MonacoDiff.displayName = 'MonacoDiff'
```

---

## 二、未使用变量/导入（警告）

### ISSUE-LINT-007: chat/route.ts 未使用导入

**位置**: `src/app/api/sessions/[id]/chat/route.ts`

| 行号 | 未使用变量 | 说明 |
|------|-----------|------|
| 3 | `analyzeScene` | 导入但未调用 |
| 4 | `PM_CONFIRMATION_PROMPT` | 对齐流程 prompt，流程未实现 |
| 4 | `buildAgentQuestionPrompt` | Agent 提问 prompt，流程未实现 |
| 119 | `cliSessionId` | 解构但未使用 |
| 164 | `cliSessionId` | 解构但未使用 |
| 180 | `cliSessionId` | 解构但未使用 |
| 318 | `cliSessionId` | 解构但未使用 |
| 460 | `handleExecution` | 函数定义但未调用 |
| 650 | `taskId` | 循环变量未使用 |

**建议修复**: 删除未使用的导入，或实现对应功能

---

### ISSUE-LINT-008: deploy/route.ts 未使用变量

**位置**: `src/app/api/deploy/route.ts:4`

**问题**:
```ts
const { files } = await request.json()  // files 未使用
```

**建议修复**: 删除解构，或实现实际部署逻辑

---

### ISSUE-LINT-009: providers/import/route.ts 未使用变量

**位置**: `src/app/api/providers/import/route.ts:5`

**问题**:
```ts
const { provider, agentType, baseUrl, model, apiKey, agentId } = await request.json()
// agentType 未使用
```

**建议修复**: 删除未使用变量，或补充类型判断逻辑

---

## 三、测试文件中的问题（不影响生产）

| 文件 | 问题 |
|------|------|
| `tests/agent-colors.test.ts` | 3 个未使用变量 |
| `tests/adapter.test.ts` | 2 个 `any` 类型 |
| `tests/database.test.ts` | 2 个未使用变量 |
| `tests/parse-json.test.ts` | 1 个 `any` 类型，1 个空对象类型 |

---

## 汇总

| 类别 | 数量 | 严重程度 |
|------|------|----------|
| React Hooks 错误 | 6 | **高**（影响性能） |
| 未使用导入/变量 | 11 | 中（代码整洁） |
| 测试文件问题 | 8 | 低（不影响生产） |

**总计**: 25 个问题（11 错误 + 14 警告，不含测试文件）

---

## 相关文件

- ESLint 配置: `eslint.config.mjs`
- 主问题文件:
  - `src/app/api/sessions/[id]/chat/route.ts`
  - `src/components/agent-panel.tsx`
  - `src/components/create-agent-dialog.tsx`
  - `src/components/create-group-dialog.tsx`
  - `src/components/provider-import-dialog.tsx`
  - `src/components/code-diff.tsx`

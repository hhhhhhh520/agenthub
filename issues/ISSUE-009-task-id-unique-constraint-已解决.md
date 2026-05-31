# 任务 ID 唯一约束冲突
> 创建时间: 2026-05-19 | 状态: 🟢已解决

## 问题描述
Orchestrator 拆解任务时，LLM 返回的任务 ID 是简单的数字（1, 2, 3...）。当同一 session 多次调用时，旧任务的 ID 仍然存在，导致 Prisma 唯一约束冲突：`Unique constraint failed on the fields: (id)`。

## 出现原因
LLM 生成的任务 ID 是从 1 开始的递增数字，不具有全局唯一性。

## 解决方案
使用 `crypto.randomUUID()` 生成唯一 ID，并建立 LLM ID 到 UUID 的映射：
```typescript
const idMap = new Map<number, string>()
parsed.tasks.forEach(t => idMap.set(t.id, crypto.randomUUID()))

const tasks: ScheduledTask[] = parsed.tasks.map(t => ({
  id: idMap.get(t.id)!,
  dependencies: t.dependencies.map(d => idMap.get(d)!).filter(Boolean),
  // ...
}))
```

## 相关文件
- `src/lib/orchestrator/index.ts` - `decomposeTasks()` 函数

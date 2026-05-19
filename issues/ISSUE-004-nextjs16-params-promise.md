# Next.js 16 动态路由 params 变为 Promise
> 创建时间: 2026-05-19 | 状态: 🟢已解决

## 问题描述
Next.js 16 中动态路由的 `params` 变为 `Promise` 类型，直接访问 `params.id` 会得到 Promise 对象而非字符串。

## 出现原因
Next.js 16 重大变更：动态路由的 `params` 参数变为异步，需要 `await`。

## 解决方案
```typescript
// 旧写法
export async function GET(request: Request, { params }: { params: { id: string } }) {
  const session = await prisma.session.findUnique({ where: { id: params.id } })
}

// 新写法
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await prisma.session.findUnique({ where: { id } })
}
```

## 相关文件
- 所有 `src/app/api/sessions/[id]/**/route.ts`

# Prisma v7 需要 Driver Adapter
> 创建时间: 2026-05-19 | 状态: 🟢已解决

## 问题描述
Prisma v7.8 的 `PrismaClient` 构造函数必须传入 `adapter` 参数，不再支持直接传入数据库 URL。运行 `npx prisma migrate dev` 后，`new PrismaClient()` 报错：`Expected 1 arguments, but got 0`。

## 出现原因
Prisma v7 重大变更：移除了内置的数据库驱动，改为使用外部 Driver Adapter。SQLite 需要 `@prisma/adapter-libsql` + `@libsql/client`。

## 解决方案
```bash
npm install @prisma/adapter-libsql @libsql/client
```

```typescript
// src/lib/db.ts
import { PrismaClient } from '@/generated/prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'

function createPrismaClient() {
  const adapter = new PrismaLibSql({
    url: process.env.DATABASE_URL || 'file:./dev.db',
  })
  return new PrismaClient({ adapter })
}
```

## 相关文件
- `src/lib/db.ts`
- `prisma/schema.prisma`
- `prisma.config.ts`

## 参考资料
- Prisma v7 迁移指南
- `@prisma/adapter-libsql` npm 包

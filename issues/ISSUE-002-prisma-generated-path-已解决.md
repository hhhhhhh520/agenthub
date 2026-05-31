# Prisma v7 生成路径变更
> 创建时间: 2026-05-19 | 状态: 🟢已解决

## 问题描述
Prisma v7 生成的客户端路径从 `@prisma/client` 变为项目内的 `src/generated/prisma/client`。原来的 `import { PrismaClient } from '@prisma/client'` 无法找到模块。

## 出现原因
Prisma v7 的 `schema.prisma` 中 `generator provider` 从 `"prisma-client-js"` 变为 `"prisma-client"`，输出路径默认为 `../src/generated/prisma`。

## 解决方案
1. `schema.prisma` 中使用 `provider = "prisma-client"` 和 `output = "../src/generated/prisma"`
2. 导入时使用 `import { PrismaClient } from '@/generated/prisma/client'`（注意是 `client` 不是目录）

## 相关文件
- `prisma/schema.prisma`
- `src/lib/db.ts`

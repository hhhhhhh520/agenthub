-- P3: Session 加 decisionTrace（决策轨迹，JSON 数组，记录"决策输入"字段回答"为什么"）
-- 只加一列，既有 drift（Attachment/Message/Task 索引）为历史既有，非本迁移引入
ALTER TABLE "Session" ADD COLUMN "decisionTrace" TEXT NOT NULL DEFAULT '[]';

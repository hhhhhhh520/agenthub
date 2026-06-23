-- AlterTable
-- contract v1 §1.2 a: 架构师拆任务时声明的简化版 outputSchema，动作 5 实施校验
ALTER TABLE "Task" ADD COLUMN "outputSchema" TEXT;
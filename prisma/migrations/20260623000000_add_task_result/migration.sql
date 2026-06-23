-- AlterTable
-- contract v1 §1.1: 主源 task.result 持久化，跨批权威
ALTER TABLE "Task" ADD COLUMN "result" TEXT;

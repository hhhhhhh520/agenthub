-- AlterTable: Add per-session agent status to SessionMember
ALTER TABLE "SessionMember" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'idle';

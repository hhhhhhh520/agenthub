/*
  Warnings:

  - You are about to drop the column `sessionId` on the `Agent` table. All the data in the column will be lost.
  - You are about to drop the column `workDir` on the `Agent` table. All the data in the column will be lost.
  - You are about to drop the column `content` on the `Message` table. All the data in the column will be lost.
  - You are about to drop the column `subtasks` on the `Task` table. All the data in the column will be lost.
  - Added the required column `rawContent` to the `Message` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `Task` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "SessionMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "role" TEXT NOT NULL DEFAULT 'member',
    CONSTRAINT "SessionMember_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionMember_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Agent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "expertise" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'llm',
    "model" TEXT NOT NULL DEFAULT '',
    "tools" TEXT NOT NULL DEFAULT '[]',
    "isPreset" BOOLEAN NOT NULL DEFAULT false,
    "accentColor" TEXT NOT NULL DEFAULT '#6366f1',
    "capabilities" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'idle'
);
INSERT INTO "new_Agent" ("expertise", "id", "name", "platform", "status", "systemPrompt") SELECT "expertise", "id", "name", "platform", "status", "systemPrompt" FROM "Agent";
DROP TABLE "Agent";
ALTER TABLE "new_Agent" RENAME TO "Agent";
CREATE TABLE "new_Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "role" TEXT NOT NULL,
    "rawContent" TEXT NOT NULL,
    "agentId" TEXT,
    "taskId" TEXT,
    "replyToId" TEXT,
    "sessionId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Message_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Message_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "Message" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Message" ("agentId", "createdAt", "id", "role", "sessionId", "taskId") SELECT "agentId", "createdAt", "id", "role", "sessionId", "taskId" FROM "Message";
DROP TABLE "Message";
ALTER TABLE "new_Message" RENAME TO "Message";
CREATE TABLE "new_Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'group',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Session" ("createdAt", "id", "title", "updatedAt") SELECT "createdAt", "id", "title", "updatedAt" FROM "Session";
DROP TABLE "Session";
ALTER TABLE "new_Session" RENAME TO "Session";
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "assignedAgentId" TEXT,
    "sessionId" TEXT NOT NULL,
    "dependencies" TEXT NOT NULL DEFAULT '[]',
    "declaredFiles" TEXT NOT NULL DEFAULT '[]',
    "workspacePath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Task_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("assignedAgentId", "createdAt", "dependencies", "description", "id", "sessionId", "status") SELECT "assignedAgentId", "createdAt", "dependencies", "description", "id", "sessionId", "status" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "SessionMember_sessionId_agentId_key" ON "SessionMember"("sessionId", "agentId");

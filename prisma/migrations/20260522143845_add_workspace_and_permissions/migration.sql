-- AlterTable
ALTER TABLE "Task" ADD COLUMN "cliSessionId" TEXT;

-- CreateTable
CREATE TABLE "RecentDir" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "path" TEXT NOT NULL,
    "lastUsed" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "useCount" INTEGER NOT NULL DEFAULT 1
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
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "apiKey" TEXT NOT NULL DEFAULT '',
    "tools" TEXT NOT NULL DEFAULT '[]',
    "isPreset" BOOLEAN NOT NULL DEFAULT false,
    "accentColor" TEXT NOT NULL DEFAULT '#6366f1',
    "capabilities" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'idle'
);
INSERT INTO "new_Agent" ("accentColor", "capabilities", "expertise", "id", "isPreset", "model", "name", "platform", "status", "systemPrompt", "tools") SELECT "accentColor", "capabilities", "expertise", "id", "isPreset", "model", "name", "platform", "status", "systemPrompt", "tools" FROM "Agent";
DROP TABLE "Agent";
ALTER TABLE "new_Agent" RENAME TO "Agent";
CREATE UNIQUE INDEX "Agent_name_key" ON "Agent"("name");
CREATE TABLE "new_Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'group',
    "phase" TEXT NOT NULL DEFAULT 'idle',
    "phaseStep" TEXT NOT NULL DEFAULT '',
    "projectDir" TEXT NOT NULL DEFAULT '',
    "permissionMode" TEXT NOT NULL DEFAULT 'default',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Session" ("createdAt", "id", "title", "type", "updatedAt") SELECT "createdAt", "id", "title", "type", "updatedAt" FROM "Session";
DROP TABLE "Session";
ALTER TABLE "new_Session" RENAME TO "Session";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "RecentDir_path_key" ON "RecentDir"("path");

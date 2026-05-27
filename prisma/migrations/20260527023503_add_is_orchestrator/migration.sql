-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Agent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "expertise" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'claude-code',
    "model" TEXT NOT NULL DEFAULT '',
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "apiKey" TEXT NOT NULL DEFAULT '',
    "tools" TEXT NOT NULL DEFAULT '[]',
    "isPreset" BOOLEAN NOT NULL DEFAULT false,
    "isOrchestrator" BOOLEAN NOT NULL DEFAULT false,
    "accentColor" TEXT NOT NULL DEFAULT '#6366f1',
    "capabilities" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'idle'
);
INSERT INTO "new_Agent" ("accentColor", "apiKey", "baseUrl", "capabilities", "expertise", "id", "isPreset", "model", "name", "platform", "status", "systemPrompt", "tools") SELECT "accentColor", "apiKey", "baseUrl", "capabilities", "expertise", "id", "isPreset", "model", "name", "platform", "status", "systemPrompt", "tools" FROM "Agent";
DROP TABLE "Agent";
ALTER TABLE "new_Agent" RENAME TO "Agent";
CREATE UNIQUE INDEX "Agent_name_key" ON "Agent"("name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

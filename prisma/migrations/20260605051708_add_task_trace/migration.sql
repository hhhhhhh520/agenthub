-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "assignedAgentId" TEXT,
    "sessionId" TEXT NOT NULL,
    "dependencies" TEXT NOT NULL DEFAULT '[]',
    "declaredFiles" TEXT NOT NULL DEFAULT '[]',
    "workspacePath" TEXT,
    "cliSessionId" TEXT,
    "correctionCount" INTEGER NOT NULL DEFAULT 0,
    "trace" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Task_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("assignedAgentId", "cliSessionId", "correctionCount", "createdAt", "declaredFiles", "dependencies", "description", "id", "sessionId", "status", "updatedAt", "workspacePath") SELECT "assignedAgentId", "cliSessionId", "correctionCount", "createdAt", "declaredFiles", "dependencies", "description", "id", "sessionId", "status", "updatedAt", "workspacePath" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

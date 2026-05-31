-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'group',
    "phase" TEXT NOT NULL DEFAULT 'idle',
    "phaseStep" TEXT NOT NULL DEFAULT '',
    "projectDir" TEXT NOT NULL DEFAULT '',
    "permissionMode" TEXT NOT NULL DEFAULT 'default',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "isArchived" BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO "new_Session" ("createdAt", "id", "permissionMode", "phase", "phaseStep", "projectDir", "title", "type", "updatedAt") SELECT "createdAt", "id", "permissionMode", "phase", "phaseStep", "projectDir", "title", "type", "updatedAt" FROM "Session";
DROP TABLE "Session";
ALTER TABLE "new_Session" RENAME TO "Session";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

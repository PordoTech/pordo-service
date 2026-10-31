-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AdminSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "csrfHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT 'content',
    "revokedAt" DATETIME,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SourceConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "proxy" TEXT,
    "timeoutMs" INTEGER NOT NULL DEFAULT 25000,
    "concurrency" INTEGER NOT NULL DEFAULT 4,
    "config" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SourceAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "username" TEXT NOT NULL,
    "passwordEnc" TEXT,
    "autoLogin" BOOLEAN NOT NULL DEFAULT true,
    "credentialId" TEXT NOT NULL DEFAULT '',
    "statusJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ComicRef" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "detailUrl" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "coverUrl" TEXT NOT NULL DEFAULT '',
    "chapterCount" INTEGER NOT NULL DEFAULT 0,
    "lastChapterKey" TEXT NOT NULL DEFAULT '',
    "resolvedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "input" TEXT NOT NULL DEFAULT '{}',
    "result" TEXT NOT NULL DEFAULT '{}',
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RequestLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "requestId" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL,
    "sourceId" TEXT,
    "op" TEXT NOT NULL,
    "status" INTEGER,
    "errorCode" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CacheEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "path" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sourceId" TEXT NOT NULL,
    "contextId" TEXT NOT NULL DEFAULT '',
    "contentType" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "hits" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "CacheSetting" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "maxBytes" INTEGER NOT NULL DEFAULT 1073741824,
    "ttlSeconds" INTEGER NOT NULL DEFAULT 1209600,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_username_key" ON "AdminUser"("username");

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_csrfHash_key" ON "AdminSession"("csrfHash");

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "SourceAccount_sourceId_key" ON "SourceAccount"("sourceId");

-- CreateIndex
CREATE INDEX "ComicRef_provider_siteId_idx" ON "ComicRef"("provider", "siteId");

-- CreateIndex
CREATE INDEX "RequestLog_createdAt_idx" ON "RequestLog"("createdAt");

-- CreateIndex
CREATE INDEX "RequestLog_kind_sourceId_idx" ON "RequestLog"("kind", "sourceId");

-- CreateIndex
CREATE INDEX "CacheEntry_lastUsedAt_idx" ON "CacheEntry"("lastUsedAt");

-- CreateIndex
CREATE INDEX "CacheEntry_sourceId_idx" ON "CacheEntry"("sourceId");

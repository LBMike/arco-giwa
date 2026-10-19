-- ArcoUSD watcher (docs/operations/arcousd-alerts.md). Two additive tables, nothing existing is
-- altered. ArcoUSDAlert keeps one row per rule key (PENDING -> OPEN -> RESOLVED, reused when the
-- condition returns); ArcoUSDHeartbeat records when each ArcoUSD background job last ran.
CREATE SCHEMA IF NOT EXISTS "arco_evm";

CREATE TABLE "arco_evm"."ArcoUSDAlert" (
  "id" TEXT NOT NULL,
  "chainId" INTEGER NOT NULL,
  "key" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "detail" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
  "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
  "openedAt" TIMESTAMPTZ(3),
  "resolvedAt" TIMESTAMPTZ(3),
  "lastNotifiedAt" TIMESTAMPTZ(3),
  "notifyCount" INTEGER NOT NULL DEFAULT 0,
  "delivery" JSONB,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "ArcoUSDAlert_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ArcoUSDAlert_severity_check" CHECK ("severity" IN ('CRITICAL', 'WARNING')),
  CONSTRAINT "ArcoUSDAlert_status_check" CHECK ("status" IN ('PENDING', 'OPEN', 'RESOLVED'))
);

CREATE UNIQUE INDEX "ArcoUSDAlert_chainId_key_key" ON "arco_evm"."ArcoUSDAlert"("chainId", "key");

CREATE INDEX "ArcoUSDAlert_chainId_status_idx" ON "arco_evm"."ArcoUSDAlert"("chainId", "status");

CREATE TABLE "arco_evm"."ArcoUSDHeartbeat" (
  "id" TEXT NOT NULL,
  "chainId" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "lastRunAt" TIMESTAMPTZ(3) NOT NULL,
  "lastOkAt" TIMESTAMPTZ(3),
  "lastError" TEXT,
  "data" JSONB,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "ArcoUSDHeartbeat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ArcoUSDHeartbeat_chainId_name_key" ON "arco_evm"."ArcoUSDHeartbeat"("chainId", "name");

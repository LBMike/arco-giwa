-- ArcoUSD reserve indexing (docs/specs/arcousd-v1.md §5). Two additive tables, nothing existing
-- is altered. ArcoUSDRedeemRequest mirrors Standard-queue requests from ArcoUSDReserve events;
-- ArcoUSDReserveSnapshot keeps periodic Lens snapshots for the admin trend and reconciliation.
CREATE SCHEMA IF NOT EXISTS "arco_evm";

CREATE TABLE "arco_evm"."ArcoUSDRedeemRequest" (
  "id" TEXT NOT NULL,
  "chainId" INTEGER NOT NULL,
  "reserveAddress" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "owner" TEXT NOT NULL,
  "recipient" TEXT NOT NULL,
  "asset" TEXT NOT NULL,
  "arcoUSDAmount" TEXT NOT NULL,
  "assetAmount" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "requestedAt" TIMESTAMPTZ(3) NOT NULL,
  "queuedTxHash" TEXT NOT NULL,
  "queuedBlock" BIGINT NOT NULL,
  "paidTxHash" TEXT,
  "paidAt" TIMESTAMPTZ(3),
  "failedTxHash" TEXT,
  "failedAt" TIMESTAMPTZ(3),
  "cancelledTxHash" TEXT,
  "cancelledAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "ArcoUSDRedeemRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ArcoUSDRedeemRequest_status_check" CHECK ("status" IN ('QUEUED', 'PAID', 'PAYOUT_FAILED', 'CANCELLED'))
);

CREATE UNIQUE INDEX "ArcoUSDRedeemRequest_chainId_reserveAddress_requestId_key" ON "arco_evm"."ArcoUSDRedeemRequest"("chainId", "reserveAddress", "requestId");

CREATE INDEX "ArcoUSDRedeemRequest_owner_chainId_status_idx" ON "arco_evm"."ArcoUSDRedeemRequest"("owner", "chainId", "status");

CREATE INDEX "ArcoUSDRedeemRequest_reserve_status_requestedAt_idx" ON "arco_evm"."ArcoUSDRedeemRequest"("chainId", "reserveAddress", "status", "requestedAt");

CREATE TABLE "arco_evm"."ArcoUSDReserveSnapshot" (
  "id" TEXT NOT NULL,
  "chainId" INTEGER NOT NULL,
  "reserveAddress" TEXT NOT NULL,
  "blockNumber" BIGINT NOT NULL,
  "takenAt" TIMESTAMPTZ(3) NOT NULL,
  "totalBacking" TEXT NOT NULL,
  "totalLiabilities" TEXT NOT NULL,
  "navOk" BOOLEAN NOT NULL,
  "mmfBps" INTEGER NOT NULL,
  "paused" BOOLEAN NOT NULL,
  "settlementPaused" BOOLEAN NOT NULL,
  "data" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ArcoUSDReserveSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ArcoUSDReserveSnapshot_chainId_reserveAddress_blockNumber_key" ON "arco_evm"."ArcoUSDReserveSnapshot"("chainId", "reserveAddress", "blockNumber");

CREATE INDEX "ArcoUSDReserveSnapshot_chainId_reserveAddress_takenAt_idx" ON "arco_evm"."ArcoUSDReserveSnapshot"("chainId", "reserveAddress", "takenAt");

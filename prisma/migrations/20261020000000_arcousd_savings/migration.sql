-- sArcoUSD (Savings) snapshots from the savings indexer (docs/specs/arcousd-v1.md §5). Additive only.
CREATE SCHEMA IF NOT EXISTS "arco_evm";
CREATE TABLE "arco_evm"."ArcoUSDSavingsSnapshot" (
  "id" TEXT NOT NULL,
  "chainId" INTEGER NOT NULL,
  "vaultAddress" TEXT NOT NULL,
  "blockNumber" BIGINT NOT NULL,
  "takenAt" TIMESTAMPTZ(3) NOT NULL,
  "totalAssets" TEXT NOT NULL,
  "totalSupply" TEXT NOT NULL,
  "sharePrice" TEXT NOT NULL,
  "aprBps" INTEGER NOT NULL,
  "data" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ArcoUSDSavingsSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ArcoUSDSavingsSnapshot_chainId_vaultAddress_blockNumber_key" ON "arco_evm"."ArcoUSDSavingsSnapshot"("chainId", "vaultAddress", "blockNumber");

CREATE INDEX "ArcoUSDSavingsSnapshot_chainId_vaultAddress_takenAt_idx" ON "arco_evm"."ArcoUSDSavingsSnapshot"("chainId", "vaultAddress", "takenAt");

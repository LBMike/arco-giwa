-- Vault display profile (P1): per-vault content shown on the product detail page, edited
-- in Vault Config. All columns nullable — null means "fall back to the legacy content".
-- Fees are integer basis points (0–10000 = 0–100%). Portfolio JSONB columns arrive in P3.
ALTER TABLE "arco_evm"."VaultConfig"
  ADD COLUMN "assetManagerName" TEXT,
  ADD COLUMN "issuerName" TEXT,
  ADD COLUMN "about" TEXT,
  ADD COLUMN "redemptionTimelineDays" INTEGER,
  ADD COLUMN "feeInstantMintingBps" INTEGER,
  ADD COLUMN "feeInstantRedemptionBps" INTEGER,
  ADD COLUMN "feeManagementBps" INTEGER,
  ADD COLUMN "feePerformanceBps" INTEGER,
  ADD COLUMN "vaultImageUrl" TEXT,
  ADD COLUMN "assetManagerImageUrl" TEXT,
  ADD COLUMN "issuerImageUrl" TEXT;

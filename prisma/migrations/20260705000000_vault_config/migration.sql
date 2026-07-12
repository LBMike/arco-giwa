-- Off-chain per-vault config (admin-ia-plan §2): display metadata, portfolio-card toggles,
-- pin/hide flags and the admin deposit address. Products without a row get defaults
-- (visible, not pinned, all card views on) — the existing vaults stay visible.
CREATE TABLE "arco_evm"."VaultConfig" (
  "id" TEXT NOT NULL,
  "chainId" INTEGER NOT NULL,
  "productId" TEXT NOT NULL,
  "displayName" TEXT,
  "category" TEXT,
  "description" TEXT,
  "adminDepositAddress" TEXT,
  "cardSnapshot" BOOLEAN NOT NULL DEFAULT true,
  "cardIndustry" BOOLEAN NOT NULL DEFAULT true,
  "cardExposure" BOOLEAN NOT NULL DEFAULT true,
  "pinned" BOOLEAN NOT NULL DEFAULT false,
  "hidden" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "VaultConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VaultConfig_chainId_productId_key" ON "arco_evm"."VaultConfig"("chainId", "productId");

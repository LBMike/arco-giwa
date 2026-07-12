-- Products-page hero carousel selection (admin-managed): a small ordered collection of
-- deployed vaults to feature. Identity (name + logo) is resolved config-first from
-- VaultConfig at render time; only the card-scoped intro (`about`), show/hide (`shown`)
-- and carousel order (`position`) live here. New cards default hidden (shown = false).
CREATE SCHEMA IF NOT EXISTS "arco_evm";

CREATE TABLE "arco_evm"."FeaturedCard" (
  "id" TEXT NOT NULL,
  "chainId" INTEGER NOT NULL,
  "productId" TEXT NOT NULL,
  "about" TEXT,
  "shown" BOOLEAN NOT NULL DEFAULT false,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "FeaturedCard_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FeaturedCard_chainId_productId_key" ON "arco_evm"."FeaturedCard"("chainId", "productId");

CREATE INDEX "FeaturedCard_chainId_position_idx" ON "arco_evm"."FeaturedCard"("chainId", "position");

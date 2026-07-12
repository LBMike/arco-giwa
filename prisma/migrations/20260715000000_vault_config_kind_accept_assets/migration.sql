-- Vault classification + Savings accept-assets.
--   kind: "product" (default — shown in Products) or "saving" (Savings page only, excluded from
--     Products). Non-null default so every existing vault backfills to "product" and stays put.
--   acceptAssets: ordered JSON array of { symbol, icon, apy, savingVaultId, isDummy } for the
--     Savings account selector (config/UI layer, not an on-chain token). Backfills to NULL.
CREATE SCHEMA IF NOT EXISTS "arco_evm";

ALTER TABLE "arco_evm"."VaultConfig"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'product',
  ADD COLUMN "acceptAssets" JSONB;

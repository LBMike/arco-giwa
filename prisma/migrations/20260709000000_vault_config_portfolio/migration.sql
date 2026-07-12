-- Vault display profile (P3): portfolio breakdowns for the detail page, edited in Vault
-- Config. JSONB arrays of { label, percent, valueUsd? }. null = fall back (Industry/Exposure
-- to legacy content; Snapshot to an explicit empty state).
ALTER TABLE "arco_evm"."VaultConfig"
  ADD COLUMN "portfolioSnapshot" JSONB,
  ADD COLUMN "portfolioIndustry" JSONB,
  ADD COLUMN "portfolioExposure" JSONB;

-- Vault display profile: free-text AUM display figure for the detail-page AUM stat
-- (e.g. "$50B", "$1.2B+"). Stored verbatim; null = fall back to the current "—".
ALTER TABLE "arco_evm"."VaultConfig" ADD COLUMN "aum" TEXT;

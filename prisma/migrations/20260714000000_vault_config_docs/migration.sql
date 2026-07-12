-- "More info" docs links (Documentation / Legal Terms / Risks): one URL + one show toggle per
-- slot. The detail renders a link only when shown AND the URL is set, so `shown` defaults true
-- while existing rows backfill to url = NULL and therefore render nothing until an operator
-- fills one in. The Smart Contracts half of "More info" is derived from the deployment registry
-- and is never stored here.
CREATE SCHEMA IF NOT EXISTS "arco_evm";

ALTER TABLE "arco_evm"."VaultConfig"
  ADD COLUMN "docsUrl" TEXT,
  ADD COLUMN "legalUrl" TEXT,
  ADD COLUMN "risksUrl" TEXT,
  ADD COLUMN "docsShown" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "legalShown" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "risksShown" BOOLEAN NOT NULL DEFAULT true;

-- Dedicated signer database migration. Apply explicitly; never in API startup.
-- No signer account or starting nonce is invented by this migration.
CREATE SCHEMA stocks_signer;

CREATE TABLE stocks_signer.account_nonce (
  "chainId" INTEGER NOT NULL CHECK ("chainId" = 91342),
  "signerAddress" TEXT NOT NULL CHECK ("signerAddress" ~ '^0x[0-9a-f]{40}$' AND "signerAddress" <> '0x0000000000000000000000000000000000000000'),
  "networkInstance" TEXT NOT NULL CHECK ("networkInstance" ~ '^[A-Za-z0-9:_-]+$' AND length("networkInstance") BETWEEN 8 AND 128),
  "checkpointNumber" TEXT NOT NULL CHECK ("checkpointNumber" ~ '^[0-9]+$'),
  "checkpointHash" TEXT NOT NULL CHECK ("checkpointHash" ~ '^0x[0-9a-f]{64}$' AND "checkpointHash" <> '0x0000000000000000000000000000000000000000000000000000000000000000'),
  "initialNonce" NUMERIC NOT NULL CHECK ("initialNonce" >= 0 AND "initialNonce" = trunc("initialNonce")),
  "nextNonce" NUMERIC NOT NULL CHECK ("nextNonce" >= "initialNonce" AND "nextNonce" = trunc("nextNonce")),
  PRIMARY KEY ("chainId", "signerAddress")
);

CREATE TABLE stocks_signer.operation (
  "operationId" TEXT PRIMARY KEY CHECK ("operationId" ~ '^(mint|refund|redeem|return):[A-Za-z0-9:_-]+$'
    AND length("operationId") - position(':' in "operationId") BETWEEN 1 AND 256),
  "chainId" INTEGER NOT NULL,
  "signerAddress" TEXT NOT NULL,
  "deploymentDigest" TEXT NOT NULL CHECK ("deploymentDigest" ~ '^[0-9a-f]{64}$'),
  "callDigest" TEXT NOT NULL CHECK ("callDigest" ~ '^[0-9a-f]{64}$'),
  call JSONB NOT NULL CHECK (jsonb_typeof(call) = 'object'),
  "originalNonce" NUMERIC NOT NULL CHECK ("originalNonce" >= 0 AND "originalNonce" = trunc("originalNonce")),
  "txHash" TEXT CHECK ("txHash" IS NULL OR ("txHash" ~ '^0x[0-9a-f]{64}$' AND "txHash" <> '0x0000000000000000000000000000000000000000000000000000000000000000')),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "hashRecordedAt" TIMESTAMPTZ,
  FOREIGN KEY ("chainId", "signerAddress") REFERENCES stocks_signer.account_nonce ("chainId", "signerAddress") ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE ("chainId", "signerAddress", "originalNonce"),
  CHECK (("txHash" IS NULL AND "hashRecordedAt" IS NULL) OR ("txHash" IS NOT NULL AND "hashRecordedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX signer_operation_transaction_hash ON stocks_signer.operation ("chainId", "txHash") WHERE "txHash" IS NOT NULL;
CREATE INDEX signer_operation_unresolved ON stocks_signer.operation ("chainId", "signerAddress") WHERE "txHash" IS NULL;

CREATE FUNCTION stocks_signer.guard_account_nonce() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."nextNonce" <> NEW."initialNonce" THEN RAISE EXCEPTION 'SIGNER_ACCOUNT_NONCE_SEED_INVALID'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'SIGNER_ACCOUNT_DELETE_FORBIDDEN'; END IF;
  IF NEW."chainId" IS DISTINCT FROM OLD."chainId" OR NEW."signerAddress" IS DISTINCT FROM OLD."signerAddress"
     OR NEW."networkInstance" IS DISTINCT FROM OLD."networkInstance"
     OR NEW."checkpointNumber" IS DISTINCT FROM OLD."checkpointNumber" OR NEW."checkpointHash" IS DISTINCT FROM OLD."checkpointHash"
     OR NEW."initialNonce" IS DISTINCT FROM OLD."initialNonce"
     OR NEW."nextNonce" <> OLD."nextNonce" + 1 THEN
    RAISE EXCEPTION 'SIGNER_ACCOUNT_NONCE_MUTATION_FORBIDDEN';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM stocks_signer.operation WHERE "chainId"=OLD."chainId"
    AND "signerAddress"=OLD."signerAddress" AND "originalNonce"=OLD."nextNonce") THEN
    RAISE EXCEPTION 'SIGNER_ACCOUNT_NONCE_ADVANCE_WITHOUT_OPERATION';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_nonce_guard BEFORE INSERT OR UPDATE OR DELETE ON stocks_signer.account_nonce FOR EACH ROW EXECUTE FUNCTION stocks_signer.guard_account_nonce();
CREATE TRIGGER account_nonce_no_truncate BEFORE TRUNCATE ON stocks_signer.account_nonce FOR EACH STATEMENT EXECUTE FUNCTION stocks_signer.guard_account_nonce();

CREATE FUNCTION stocks_signer.guard_operation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."txHash" IS NOT NULL OR NEW."hashRecordedAt" IS NOT NULL THEN RAISE EXCEPTION 'SIGNER_OPERATION_INSERT_HASH_FORBIDDEN'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'SIGNER_OPERATION_DELETE_FORBIDDEN'; END IF;
  IF NEW."operationId" IS DISTINCT FROM OLD."operationId" OR NEW."chainId" IS DISTINCT FROM OLD."chainId"
     OR NEW."signerAddress" IS DISTINCT FROM OLD."signerAddress" OR NEW."deploymentDigest" IS DISTINCT FROM OLD."deploymentDigest"
     OR NEW."callDigest" IS DISTINCT FROM OLD."callDigest" OR NEW.call IS DISTINCT FROM OLD.call
     OR NEW."originalNonce" IS DISTINCT FROM OLD."originalNonce" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR OLD."txHash" IS NOT NULL OR NEW."txHash" IS NULL OR NEW."hashRecordedAt" IS NULL THEN
    RAISE EXCEPTION 'SIGNER_OPERATION_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER operation_guard BEFORE INSERT OR UPDATE OR DELETE ON stocks_signer.operation FOR EACH ROW EXECUTE FUNCTION stocks_signer.guard_operation();
CREATE TRIGGER operation_no_truncate BEFORE TRUNCATE ON stocks_signer.operation FOR EACH STATEMENT EXECUTE FUNCTION stocks_signer.guard_operation();

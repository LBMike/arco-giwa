-- The hash of the externally signed original must be committed before the
-- first broadcast. This additive migration seeds no intent and signs nothing.
BEGIN;
-- The earlier inactive journal did not commit signed bytes. Historical rows
-- cannot be safely inferred or backfilled from their call/nonce alone.
LOCK TABLE stocks_signer.operation IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM stocks_signer.operation) THEN
    RAISE EXCEPTION 'SIGNER_SIGNED_INTENT_MIGRATION_REQUIRES_EMPTY_OPERATION_TABLE';
  END IF;
END $$;

CREATE TABLE stocks_signer.signed_intent (
  "operationId" TEXT PRIMARY KEY REFERENCES stocks_signer.operation ("operationId") ON UPDATE RESTRICT ON DELETE RESTRICT,
  "signedHash" TEXT NOT NULL UNIQUE CHECK ("signedHash" ~ '^0x[0-9a-f]{64}$'
    AND "signedHash" <> '0x0000000000000000000000000000000000000000000000000000000000000000'),
  "recordedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION stocks_signer.guard_signed_intent() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM stocks_signer.operation WHERE "operationId"=NEW."operationId" AND "txHash" IS NULL) THEN
      RAISE EXCEPTION 'SIGNER_SIGNED_INTENT_WITHOUT_UNRESOLVED_OPERATION';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SIGNER_SIGNED_INTENT_IMMUTABLE';
END $$;
CREATE TRIGGER signed_intent_guard BEFORE INSERT OR UPDATE OR DELETE ON stocks_signer.signed_intent
  FOR EACH ROW EXECUTE FUNCTION stocks_signer.guard_signed_intent();
CREATE TRIGGER signed_intent_no_truncate BEFORE TRUNCATE ON stocks_signer.signed_intent
  FOR EACH STATEMENT EXECUTE FUNCTION stocks_signer.guard_signed_intent();

-- The original operation table's prior guard prevents changing an already
-- completed hash. This second guard prevents completing it with any hash that
-- was not immutably recorded as the signed bytes' hash before broadcast.
CREATE FUNCTION stocks_signer.require_signed_intent() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stocks_signer.signed_intent
    WHERE "operationId"=NEW."operationId" AND "signedHash"=NEW."txHash") THEN
    RAISE EXCEPTION 'SIGNER_OPERATION_SIGNED_INTENT_MISMATCH';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER operation_signed_intent_guard BEFORE UPDATE OF "txHash" ON stocks_signer.operation
  FOR EACH ROW EXECUTE FUNCTION stocks_signer.require_signed_intent();
COMMIT;

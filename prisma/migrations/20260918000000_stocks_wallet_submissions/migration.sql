-- Additive only. Existing orders are deliberately NOT enrolled or backfilled.
CREATE TABLE arco_evm."StocksWalletSubmissionEnrollment" (
 side TEXT NOT NULL CHECK(side IN('BUY','SELL')), "orderId" TEXT NOT NULL,
 "intentKey" TEXT NOT NULL UNIQUE CHECK("intentKey" ~ '^[0-9a-f]{64}$'),
 "actorId" TEXT NOT NULL, wallet TEXT NOT NULL CHECK(wallet ~ '^0x[0-9a-f]{40}$'),
 "deploymentDigest" TEXT NOT NULL CHECK("deploymentDigest" ~ '^[0-9a-f]{64}$'),
 "orderBinding" TEXT NOT NULL CHECK("orderBinding" ~ '^[0-9a-f]{64}$'),
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(side,"orderId")
);
CREATE TABLE arco_evm."StocksWalletSubmission" (
 "claimId" TEXT PRIMARY KEY, "intentKey" TEXT NOT NULL CHECK("intentKey" ~ '^[0-9a-f]{64}$'),
 stage TEXT NOT NULL CHECK(stage IN('APPROVAL','TRANSFER')),
 "transactionDigest" TEXT NOT NULL CHECK("transactionDigest" ~ '^[0-9a-f]{64}$'), transaction JSONB NOT NULL,
 "actorId" TEXT NOT NULL, wallet TEXT NOT NULL CHECK(wallet ~ '^0x[0-9a-f]{40}$'),
 side TEXT NOT NULL CHECK(side IN('BUY','SELL')), "orderId" TEXT NOT NULL,
 "deploymentDigest" TEXT NOT NULL CHECK("deploymentDigest" ~ '^[0-9a-f]{64}$'),
 status TEXT NOT NULL CHECK(status IN('REQUEST_MAY_START','UNKNOWN','SUBMITTED')),
 "txHash" TEXT CHECK("txHash" ~ '^0x[0-9a-f]{64}$' AND "txHash" <> '0x' || repeat('0',64)),
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE("intentKey",stage),
 CHECK(status <> 'SUBMITTED' OR "txHash" IS NOT NULL),
 CHECK(status <> 'REQUEST_MAY_START' OR "txHash" IS NULL),
 FOREIGN KEY(side,"orderId") REFERENCES arco_evm."StocksWalletSubmissionEnrollment"(side,"orderId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE FUNCTION arco_evm.stocks_wallet_submission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'SUBMISSION_DELETE_FORBIDDEN'; END IF;
 IF TG_TABLE_NAME = 'StocksWalletSubmissionEnrollment' THEN RAISE EXCEPTION 'ENROLLMENT_IMMUTABLE'; END IF;
 IF ROW(NEW."claimId",NEW."intentKey",NEW.stage,NEW."transactionDigest",NEW.transaction,NEW."actorId",NEW.wallet,NEW.side,NEW."orderId",NEW."deploymentDigest",NEW."createdAt") IS DISTINCT FROM ROW(OLD."claimId",OLD."intentKey",OLD.stage,OLD."transactionDigest",OLD.transaction,OLD."actorId",OLD.wallet,OLD.side,OLD."orderId",OLD."deploymentDigest",OLD."createdAt") THEN RAISE EXCEPTION 'SUBMISSION_BINDING_IMMUTABLE'; END IF;
 IF (OLD.status <> 'REQUEST_MAY_START' AND NEW.status = 'REQUEST_MAY_START') OR (OLD.status='SUBMITTED' AND NEW.status<>'SUBMITTED') THEN RAISE EXCEPTION 'SUBMISSION_STATUS_REGRESSION'; END IF;
 IF OLD."txHash" IS NOT NULL AND NEW."txHash" IS DISTINCT FROM OLD."txHash" THEN RAISE EXCEPTION 'SUBMISSION_HASH_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "StocksWalletSubmission_guard" BEFORE UPDATE OR DELETE ON arco_evm."StocksWalletSubmission" FOR EACH ROW EXECUTE FUNCTION arco_evm.stocks_wallet_submission_guard();
CREATE TRIGGER "StocksWalletEnrollment_guard" BEFORE UPDATE OR DELETE ON arco_evm."StocksWalletSubmissionEnrollment" FOR EACH ROW EXECUTE FUNCTION arco_evm.stocks_wallet_submission_guard();
CREATE TRIGGER "StocksWalletSubmission_no_truncate" BEFORE TRUNCATE ON arco_evm."StocksWalletSubmission" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm.stocks_wallet_submission_guard();
CREATE TRIGGER "StocksWalletEnrollment_no_truncate" BEFORE TRUNCATE ON arco_evm."StocksWalletSubmissionEnrollment" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm.stocks_wallet_submission_guard();

-- Additive trusted evidence. No existing row is promoted or backfilled.
CREATE TABLE arco_evm."StocksWalletSubmissionProof" (
 "claimId" TEXT PRIMARY KEY REFERENCES arco_evm."StocksWalletSubmission"("claimId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "intentKey" TEXT NOT NULL CHECK("intentKey" ~ '^[0-9a-f]{64}$'),
 "transactionDigest" TEXT NOT NULL CHECK("transactionDigest" ~ '^[0-9a-f]{64}$'),
 "deploymentDigest" TEXT NOT NULL CHECK("deploymentDigest" ~ '^[0-9a-f]{64}$'),
 "txHash" TEXT NOT NULL CHECK("txHash" ~ '^0x[0-9a-f]{64}$' AND "txHash" <> '0x' || repeat('0',64)),
 status TEXT NOT NULL CHECK(status IN ('CONFIRMED','REVERTED')),
 "blockNumber" NUMERIC NOT NULL CHECK("blockNumber" >= 0 AND "blockNumber" = trunc("blockNumber")),
 "blockHash" TEXT NOT NULL CHECK("blockHash" ~ '^0x[0-9a-f]{64}$' AND "blockHash" <> '0x' || repeat('0',64)),
 "proofDigest" TEXT NOT NULL CHECK("proofDigest" ~ '^[0-9a-f]{64}$'), evidence JSONB NOT NULL,
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER "StocksWalletProof_immutable" BEFORE UPDATE OR DELETE ON arco_evm."StocksWalletSubmissionProof" FOR EACH ROW EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE TRIGGER "StocksWalletProof_no_truncate" BEFORE TRUNCATE ON arco_evm."StocksWalletSubmissionProof" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
ALTER TABLE arco_evm."StocksWalletSubmission" DROP CONSTRAINT "StocksWalletSubmission_status_check";
ALTER TABLE arco_evm."StocksWalletSubmission" ADD CONSTRAINT "StocksWalletSubmission_status_check" CHECK(status IN('REQUEST_MAY_START','UNKNOWN','SUBMITTED','CONFIRMED','REVERTED'));
ALTER TABLE arco_evm."StocksWalletSubmission" ADD CONSTRAINT "StocksWalletSubmission_terminal_hash" CHECK(status NOT IN('CONFIRMED','REVERTED') OR "txHash" IS NOT NULL);
CREATE OR REPLACE FUNCTION arco_evm.stocks_wallet_submission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'SUBMISSION_DELETE_FORBIDDEN'; END IF;
 IF TG_TABLE_NAME = 'StocksWalletSubmissionEnrollment' THEN RAISE EXCEPTION 'ENROLLMENT_IMMUTABLE'; END IF;
 IF ROW(NEW."claimId",NEW."intentKey",NEW.stage,NEW."transactionDigest",NEW.transaction,NEW."actorId",NEW.wallet,NEW.side,NEW."orderId",NEW."deploymentDigest",NEW."createdAt") IS DISTINCT FROM ROW(OLD."claimId",OLD."intentKey",OLD.stage,OLD."transactionDigest",OLD.transaction,OLD."actorId",OLD.wallet,OLD.side,OLD."orderId",OLD."deploymentDigest",OLD."createdAt") THEN RAISE EXCEPTION 'SUBMISSION_BINDING_IMMUTABLE'; END IF;
 IF (OLD.status IN ('CONFIRMED','REVERTED') AND NEW.status <> OLD.status) OR (OLD.status <> 'REQUEST_MAY_START' AND NEW.status = 'REQUEST_MAY_START') OR (OLD.status='SUBMITTED' AND NEW.status NOT IN ('SUBMITTED','CONFIRMED','REVERTED')) THEN RAISE EXCEPTION 'SUBMISSION_STATUS_REGRESSION'; END IF;
 IF OLD."txHash" IS NOT NULL AND NEW."txHash" IS DISTINCT FROM OLD."txHash" THEN RAISE EXCEPTION 'SUBMISSION_HASH_IMMUTABLE'; END IF;
 IF NEW.status IN ('CONFIRMED','REVERTED') AND NOT EXISTS(SELECT 1 FROM arco_evm."StocksWalletSubmissionProof" p WHERE p."claimId"=NEW."claimId" AND p."intentKey"=NEW."intentKey" AND p."transactionDigest"=NEW."transactionDigest" AND p."deploymentDigest"=NEW."deploymentDigest" AND p."txHash"=NEW."txHash" AND p.status=NEW.status) THEN RAISE EXCEPTION 'SUBMISSION_TRUSTED_PROOF_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION arco_evm.stocks_wallet_submission_initial() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status <> 'REQUEST_MAY_START' OR NEW."txHash" IS NOT NULL THEN RAISE EXCEPTION 'SUBMISSION_INITIAL_STATE_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "StocksWalletSubmission_initial" BEFORE INSERT ON arco_evm."StocksWalletSubmission" FOR EACH ROW EXECUTE FUNCTION arco_evm.stocks_wallet_submission_initial();
CREATE FUNCTION arco_evm.stocks_wallet_proof_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM arco_evm."StocksWalletSubmission" s WHERE s."claimId"=NEW."claimId" AND s."intentKey"=NEW."intentKey" AND s."transactionDigest"=NEW."transactionDigest" AND s."deploymentDigest"=NEW."deploymentDigest" AND s."txHash"=NEW."txHash" AND s.status IN('UNKNOWN','SUBMITTED')) THEN RAISE EXCEPTION 'SUBMISSION_PROOF_BINDING_MISMATCH'; END IF;
 IF NOT (NEW.evidence @> jsonb_build_object('version',1,'claimId',NEW."claimId",'intentKey',NEW."intentKey",'transactionDigest',NEW."transactionDigest",'deploymentDigest',NEW."deploymentDigest",'txHash',NEW."txHash",'status',NEW.status,'blockNumber',NEW."blockNumber"::text,'blockHash',NEW."blockHash")) THEN RAISE EXCEPTION 'SUBMISSION_PROOF_ENVELOPE_MISMATCH'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "StocksWalletProof_binding" BEFORE INSERT ON arco_evm."StocksWalletSubmissionProof" FOR EACH ROW EXECUTE FUNCTION arco_evm.stocks_wallet_proof_binding();

-- New GIWA Stocks domain only. No existing Savings/Funds table or live deployment is changed.
CREATE TABLE arco_evm."StocksQuote" (
  id TEXT PRIMARY KEY, "actorId" TEXT NOT NULL, wallet TEXT NOT NULL, symbol TEXT NOT NULL CHECK (symbol='NVDA'),
  quantity NUMERIC NOT NULL CHECK (quantity=trunc(quantity) AND quantity>0 AND quantity<=1e36),
  "cashAmount" NUMERIC NOT NULL CHECK ("cashAmount"=trunc("cashAmount") AND "cashAmount">0 AND "cashAmount"<=1e36),
  "deploymentDigest" TEXT NOT NULL, "expiresAt" TIMESTAMPTZ NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE arco_evm."StocksOrder" (
  id TEXT PRIMARY KEY, "orderKey" TEXT NOT NULL UNIQUE, "quoteId" TEXT NOT NULL UNIQUE REFERENCES arco_evm."StocksQuote"(id),
  "actorId" TEXT NOT NULL, wallet TEXT NOT NULL, symbol TEXT NOT NULL CHECK (symbol='NVDA'),
  quantity NUMERIC NOT NULL CHECK (quantity=trunc(quantity) AND quantity>0 AND quantity<=1e36),
  "cashAmount" NUMERIC NOT NULL CHECK ("cashAmount"=trunc("cashAmount") AND "cashAmount">0 AND "cashAmount"<=1e36),
  "idempotencyKey" TEXT NOT NULL, "deploymentId" TEXT NOT NULL, "deploymentDigest" TEXT NOT NULL,
  "quoteExpiresAt" TIMESTAMPTZ NOT NULL, state TEXT NOT NULL DEFAULT 'AWAITING_FUNDING' CHECK (state IN ('AWAITING_FUNDING','FUNDED_QUOTE_EXPIRED','FUNDING_REVIEW_REQUIRED','BROKER_PENDING','BROKER_UNKNOWN','MINT_QUEUED','MINT_SUBMITTED','MINT_FINALITY_PENDING','MINT_UNKNOWN','COMPLETED','REFUNDED','REVIEW_REQUIRED')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version>=0), "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("actorId","idempotencyKey")
);
CREATE INDEX "StocksOrder_actor" ON arco_evm."StocksOrder" ("actorId","deploymentDigest","createdAt");
CREATE TABLE arco_evm."StocksFunding" (
  id TEXT PRIMARY KEY, "orderId" TEXT REFERENCES arco_evm."StocksOrder"(id), payer TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount=trunc(amount) AND amount>0 AND amount<=1e36),
  status TEXT NOT NULL CHECK (status IN ('ACCEPTED','SUSPENSE','REFUND_PENDING','REFUNDED')), reason TEXT NOT NULL,
  "txHash" TEXT NOT NULL, proof JSONB NOT NULL, "deploymentDigest" TEXT NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE arco_evm."StocksOutbox" (
  id TEXT PRIMARY KEY, "orderId" TEXT REFERENCES arco_evm."StocksOrder"(id), kind TEXT NOT NULL CHECK (kind IN ('BROKER','MINT','REFUND')),
  payload JSONB NOT NULL, "deploymentDigest" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','STARTED','UNKNOWN','SUBMITTED','DONE','REVIEW')),
  "txHash" TEXT, "leaseId" TEXT, "leaseUntil" TIMESTAMPTZ, "nextAttemptAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX "StocksOutbox_dispatch" ON arco_evm."StocksOutbox" ("deploymentDigest",status,"nextAttemptAt");
CREATE UNIQUE INDEX "StocksOutbox_transaction" ON arco_evm."StocksOutbox" ("deploymentDigest","txHash") WHERE "txHash" IS NOT NULL;
-- Each immutable row is one journal pair: equal debit/credit amounts in the same asset.
-- Unconstrained NUMERIC + integral check avoids typmod rounding malformed fractional input.
CREATE TABLE arco_evm."StocksJournal" (
  id TEXT PRIMARY KEY, asset TEXT NOT NULL, debit TEXT NOT NULL, credit TEXT NOT NULL CHECK (debit<>credit),
  amount NUMERIC NOT NULL CHECK (amount=trunc(amount) AND amount>0 AND amount<=1e36),
  "deploymentDigest" TEXT NOT NULL, "blockNumber" NUMERIC CHECK ("blockNumber"=trunc("blockNumber") AND "blockNumber">=0),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE arco_evm."StocksHolding" (
  "orderId" TEXT PRIMARY KEY REFERENCES arco_evm."StocksOrder"(id), "actorId" TEXT NOT NULL, wallet TEXT NOT NULL, symbol TEXT NOT NULL CHECK (symbol='NVDA'),
  quantity NUMERIC NOT NULL CHECK (quantity=trunc(quantity) AND quantity>0 AND quantity<=1e36),
  "deploymentId" TEXT NOT NULL, "deploymentDigest" TEXT NOT NULL, "txHash" TEXT NOT NULL, "blockHash" TEXT NOT NULL,
  "blockNumber" NUMERIC NOT NULL CHECK ("blockNumber"=trunc("blockNumber") AND "blockNumber">=0), "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE arco_evm."StocksAudit" (
  id TEXT PRIMARY KEY, subject TEXT NOT NULL, action TEXT NOT NULL, detail JSONB NOT NULL,
  "deploymentDigest" TEXT NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE arco_evm."StocksProviderReceipt" (
  id TEXT PRIMARY KEY, "deploymentDigest" TEXT NOT NULL, "requestDigest" TEXT NOT NULL, result JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION arco_evm."StocksRejectMutation"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Stocks immutable fact: append corrections, never update or delete';
END;
$$;
CREATE TRIGGER "StocksQuote_immutable" BEFORE UPDATE OR DELETE ON arco_evm."StocksQuote" FOR EACH ROW EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE TRIGGER "StocksJournal_immutable" BEFORE UPDATE OR DELETE ON arco_evm."StocksJournal" FOR EACH ROW EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE TRIGGER "StocksAudit_immutable" BEFORE UPDATE OR DELETE ON arco_evm."StocksAudit" FOR EACH ROW EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE TRIGGER "StocksHolding_immutable" BEFORE UPDATE OR DELETE ON arco_evm."StocksHolding" FOR EACH ROW EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE TRIGGER "StocksProviderReceipt_immutable" BEFORE UPDATE OR DELETE ON arco_evm."StocksProviderReceipt" FOR EACH ROW EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE FUNCTION arco_evm."StocksProtectOrder"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Stocks orders cannot be deleted'; END IF;
  IF (to_jsonb(NEW)-'state'-'version'-'updatedAt') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'version'-'updatedAt') OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'Stocks order snapshot immutable / version must advance';
  END IF;
  IF OLD.state IN ('COMPLETED','REFUNDED') AND NEW.state<>OLD.state THEN RAISE EXCEPTION 'Stocks terminal state immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "StocksOrder_snapshot" BEFORE UPDATE OR DELETE ON arco_evm."StocksOrder" FOR EACH ROW EXECUTE FUNCTION arco_evm."StocksProtectOrder"();
CREATE FUNCTION arco_evm."StocksProtectFunding"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Stocks funding cannot be deleted'; END IF;
  IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN RAISE EXCEPTION 'Stocks funding evidence immutable'; END IF;
  IF NOT ((OLD.status='SUSPENSE' AND NEW.status='REFUND_PENDING') OR (OLD.status='REFUND_PENDING' AND NEW.status='REFUNDED')) THEN RAISE EXCEPTION 'Invalid funding transition'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "StocksFunding_snapshot" BEFORE UPDATE OR DELETE ON arco_evm."StocksFunding" FOR EACH ROW EXECUTE FUNCTION arco_evm."StocksProtectFunding"();
CREATE FUNCTION arco_evm."StocksProtectIntent"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Stocks intent cannot be deleted'; END IF;
  IF (to_jsonb(NEW)-'status'-'txHash'-'leaseId'-'leaseUntil'-'nextAttemptAt') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'txHash'-'leaseId'-'leaseUntil'-'nextAttemptAt') OR (OLD."txHash" IS NOT NULL AND NEW."txHash" IS DISTINCT FROM OLD."txHash") THEN
    RAISE EXCEPTION 'Stocks intent identity immutable';
  END IF;
  IF OLD.status IN ('DONE','REVIEW') AND NEW.status<>OLD.status THEN RAISE EXCEPTION 'Stocks terminal intent immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "StocksOutbox_snapshot" BEFORE UPDATE OR DELETE ON arco_evm."StocksOutbox" FOR EACH ROW EXECUTE FUNCTION arco_evm."StocksProtectIntent"();

-- TRUNCATE bypasses row mutation triggers; protect every Stocks fact/state table.
CREATE TRIGGER "StocksQuote_no_truncate" BEFORE TRUNCATE ON arco_evm."StocksQuote" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE TRIGGER "StocksOrder_no_truncate" BEFORE TRUNCATE ON arco_evm."StocksOrder" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE TRIGGER "StocksFunding_no_truncate" BEFORE TRUNCATE ON arco_evm."StocksFunding" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE TRIGGER "StocksOutbox_no_truncate" BEFORE TRUNCATE ON arco_evm."StocksOutbox" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE TRIGGER "StocksJournal_no_truncate" BEFORE TRUNCATE ON arco_evm."StocksJournal" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE TRIGGER "StocksHolding_no_truncate" BEFORE TRUNCATE ON arco_evm."StocksHolding" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE TRIGGER "StocksAudit_no_truncate" BEFORE TRUNCATE ON arco_evm."StocksAudit" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE TRIGGER "StocksProviderReceipt_no_truncate" BEFORE TRUNCATE ON arco_evm."StocksProviderReceipt" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm."StocksRejectMutation"();

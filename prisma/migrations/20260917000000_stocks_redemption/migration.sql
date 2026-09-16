CREATE TABLE arco_evm."StocksSellQuote" (
 id TEXT PRIMARY KEY, "actorId" TEXT NOT NULL, wallet TEXT NOT NULL, symbol TEXT NOT NULL CHECK(symbol='NVDA'),
 quantity NUMERIC NOT NULL CHECK(quantity=trunc(quantity) AND quantity>0 AND quantity<=1e36),
 "cashAmount" NUMERIC NOT NULL CHECK("cashAmount"=trunc("cashAmount") AND "cashAmount">0 AND "cashAmount"<=1e36),
 "deploymentDigest" TEXT NOT NULL, "expiresAt" TIMESTAMPTZ NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE arco_evm."StocksSellOrder" (
 id TEXT PRIMARY KEY, "orderKey" TEXT NOT NULL UNIQUE, "quoteId" TEXT NOT NULL UNIQUE REFERENCES arco_evm."StocksSellQuote"(id),
 "actorId" TEXT NOT NULL, wallet TEXT NOT NULL, symbol TEXT NOT NULL CHECK(symbol='NVDA'),
 quantity NUMERIC NOT NULL CHECK(quantity=trunc(quantity) AND quantity>0 AND quantity<=1e36),
 "cashAmount" NUMERIC NOT NULL CHECK("cashAmount"=trunc("cashAmount") AND "cashAmount">0 AND "cashAmount"<=1e36),
 "idempotencyKey" TEXT NOT NULL, "deploymentId" TEXT NOT NULL, "deploymentDigest" TEXT NOT NULL, "quoteExpiresAt" TIMESTAMPTZ NOT NULL,
 state TEXT NOT NULL DEFAULT 'AWAITING_ESCROW' CHECK(state IN('AWAITING_ESCROW','EXPIRED','ESCROW_HELD','ESCROW_REVIEW_REQUIRED','LIQUIDITY_PENDING','SELL_BROKER_PENDING','SELL_BROKER_UNKNOWN','SELL_PARTIAL_HELD','REDEEM_QUEUED','RETURN_QUEUED','SETTLEMENT_PENDING','SETTLEMENT_UNKNOWN','COMPLETED','RETURNED','REVIEW_REQUIRED')),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0), "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), UNIQUE("actorId","idempotencyKey")
);
CREATE TABLE arco_evm."StocksQuantityReservation" (
 "orderId" TEXT PRIMARY KEY REFERENCES arco_evm."StocksSellOrder"(id), "deploymentDigest" TEXT NOT NULL, wallet TEXT NOT NULL,
 quantity NUMERIC NOT NULL CHECK(quantity=trunc(quantity) AND quantity>0 AND quantity<=1e36), status TEXT NOT NULL CHECK(status IN('ACTIVE','RELEASED','CONSUMED')),
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE arco_evm."StocksCustody" (
 id TEXT PRIMARY KEY, "escrowId" TEXT NOT NULL, "orderId" TEXT REFERENCES arco_evm."StocksSellOrder"(id), "deploymentDigest" TEXT NOT NULL,
 payer TEXT NOT NULL, quantity NUMERIC NOT NULL CHECK(quantity=trunc(quantity) AND quantity>0 AND quantity<=1e36),
 reason TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN('HELD','RETURN_PENDING','REDEEM_PENDING','RETURNED','REDEEMED')),
 "txHash" TEXT NOT NULL, proof JSONB NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), UNIQUE("deploymentDigest","escrowId")
);
CREATE TABLE arco_evm."StocksQuantityMovement" (
 id TEXT PRIMARY KEY, "deploymentDigest" TEXT NOT NULL, wallet TEXT NOT NULL, "custodyId" TEXT REFERENCES arco_evm."StocksCustody"(id),
 "walletDelta" NUMERIC NOT NULL CHECK("walletDelta"=trunc("walletDelta") AND abs("walletDelta")<=1e36),
 "escrowDelta" NUMERIC NOT NULL CHECK("escrowDelta"=trunc("escrowDelta") AND abs("escrowDelta")<=1e36),
 "supplyDelta" NUMERIC NOT NULL CHECK("supplyDelta"=trunc("supplyDelta") AND abs("supplyDelta")<=1e36),
 "blockNumber" NUMERIC NOT NULL CHECK("blockNumber"=trunc("blockNumber") AND "blockNumber">=0), "blockHash" TEXT NOT NULL, "txHash" TEXT NOT NULL,
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), CHECK("walletDelta"+"escrowDelta"="supplyDelta")
);
CREATE TABLE arco_evm."StocksCashReservation" (
 "orderId" TEXT PRIMARY KEY REFERENCES arco_evm."StocksSellOrder"(id), "deploymentDigest" TEXT NOT NULL, "scopeKey" TEXT NOT NULL,
 amount NUMERIC NOT NULL CHECK(amount=trunc(amount) AND amount>0 AND amount<=1e36), status TEXT NOT NULL CHECK(status IN('RESERVED','RELEASED','CONSUMED')),
 proof JSONB NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE arco_evm."StocksObserverCursor" (
 "deploymentDigest" TEXT PRIMARY KEY, "blockNumber" NUMERIC NOT NULL CHECK("blockNumber"=trunc("blockNumber") AND "blockNumber">=0),
 "blockHash" TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE arco_evm."StocksOutbox" ADD COLUMN "sellOrderId" TEXT REFERENCES arco_evm."StocksSellOrder"(id);
ALTER TABLE arco_evm."StocksOutbox" DROP CONSTRAINT "StocksOutbox_kind_check";
ALTER TABLE arco_evm."StocksOutbox" ADD CONSTRAINT "StocksOutbox_kind_check" CHECK(kind IN('BROKER','MINT','REFUND','SELL_BROKER','REDEEM','RETURN'));
ALTER TABLE arco_evm."StocksOutbox" ADD CONSTRAINT "StocksOutbox_order_domain_check" CHECK(NOT("orderId" IS NOT NULL AND "sellOrderId" IS NOT NULL));
CREATE INDEX "StocksSellOrder_actor" ON arco_evm."StocksSellOrder"("deploymentDigest","actorId","createdAt");
CREATE TRIGGER "StocksSellQuote_immutable" BEFORE UPDATE OR DELETE ON arco_evm."StocksSellQuote" FOR EACH ROW EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE TRIGGER "StocksQuantityMovement_immutable" BEFORE UPDATE OR DELETE ON arco_evm."StocksQuantityMovement" FOR EACH ROW EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE FUNCTION arco_evm."StocksProtectSellOrder"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Sell order immutable'; END IF;
 IF (to_jsonb(NEW)-'state'-'version'-'updatedAt') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'version'-'updatedAt') OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Sell snapshot immutable / stale version'; END IF;
 IF OLD.state IN('COMPLETED','RETURNED') AND NEW.state<>OLD.state THEN RAISE EXCEPTION 'Sell terminal immutable'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER "StocksSellOrder_snapshot" BEFORE UPDATE OR DELETE ON arco_evm."StocksSellOrder" FOR EACH ROW EXECUTE FUNCTION arco_evm."StocksProtectSellOrder"();
CREATE FUNCTION arco_evm."StocksProtectReservation"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reservation immutable'; END IF;
 IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN RAISE EXCEPTION 'Reservation identity immutable'; END IF;
 IF NOT(OLD.status IN('ACTIVE','RESERVED') AND NEW.status IN('RELEASED','CONSUMED')) THEN RAISE EXCEPTION 'Reservation transition invalid'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER "StocksQuantityReservation_snapshot" BEFORE UPDATE OR DELETE ON arco_evm."StocksQuantityReservation" FOR EACH ROW EXECUTE FUNCTION arco_evm."StocksProtectReservation"();
CREATE TRIGGER "StocksCashReservation_snapshot" BEFORE UPDATE OR DELETE ON arco_evm."StocksCashReservation" FOR EACH ROW EXECUTE FUNCTION arco_evm."StocksProtectReservation"();
CREATE FUNCTION arco_evm."StocksProtectCustody"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Custody immutable'; END IF;
 IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN RAISE EXCEPTION 'Custody evidence immutable'; END IF;
 IF NOT((OLD.status='HELD' AND NEW.status IN('RETURN_PENDING','REDEEM_PENDING')) OR (OLD.status='RETURN_PENDING' AND NEW.status='RETURNED') OR (OLD.status='REDEEM_PENDING' AND NEW.status='REDEEMED')) THEN RAISE EXCEPTION 'Custody transition invalid'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER "StocksCustody_snapshot" BEFORE UPDATE OR DELETE ON arco_evm."StocksCustody" FOR EACH ROW EXECUTE FUNCTION arco_evm."StocksProtectCustody"();
CREATE TRIGGER "StocksSellQuote_no_truncate" BEFORE TRUNCATE ON arco_evm."StocksSellQuote" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE TRIGGER "StocksSellOrder_no_truncate" BEFORE TRUNCATE ON arco_evm."StocksSellOrder" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE TRIGGER "StocksQuantityReservation_no_truncate" BEFORE TRUNCATE ON arco_evm."StocksQuantityReservation" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE TRIGGER "StocksCashReservation_no_truncate" BEFORE TRUNCATE ON arco_evm."StocksCashReservation" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE TRIGGER "StocksCustody_no_truncate" BEFORE TRUNCATE ON arco_evm."StocksCustody" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE TRIGGER "StocksQuantityMovement_no_truncate" BEFORE TRUNCATE ON arco_evm."StocksQuantityMovement" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm."StocksRejectMutation"();

CREATE TABLE arco_evm."StocksLiquidityBinding" (
 "scopeKey" TEXT PRIMARY KEY, "deploymentDigest" TEXT NOT NULL UNIQUE, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER "StocksLiquidityBinding_immutable" BEFORE UPDATE OR DELETE ON arco_evm."StocksLiquidityBinding" FOR EACH ROW EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE TRIGGER "StocksLiquidityBinding_no_truncate" BEFORE TRUNCATE ON arco_evm."StocksLiquidityBinding" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm."StocksRejectMutation"();

-- Per-symbol, per-side trading limits for the Stocks runtime (read only when STOCKS_TRADING_LIMITS=1).
-- A missing row, like the version-0 row the first change creates, means: side enabled, no daily cap.
-- Nothing is backfilled and no existing table changes; the daily total is computed from the order tables.
CREATE TABLE arco_evm."StocksTradingLimit" (
  "deploymentDigest" TEXT NOT NULL CHECK ("deploymentDigest" ~ '^[0-9a-f]{64}$'),
  symbol TEXT NOT NULL CHECK (symbol ~ '^[A-Z][A-Z0-9.]{0,9}$'),
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- Cash token base units per KST day, all wallets together. NULL means no cap.
  "dailyCashLimit" NUMERIC CHECK ("dailyCashLimit" IS NULL OR ("dailyCashLimit"=trunc("dailyCashLimit") AND "dailyCashLimit">0 AND "dailyCashLimit"<=1e30)),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  "updatedAt" TIMESTAMPTZ,
  "operatorId" TEXT,
  reason TEXT,
  PRIMARY KEY ("deploymentDigest", symbol, side),
  CHECK ((version=0 AND enabled AND "dailyCashLimit" IS NULL AND "updatedAt" IS NULL AND "operatorId" IS NULL AND reason IS NULL) OR
         (version>0 AND "updatedAt" IS NOT NULL AND "operatorId" IS NOT NULL AND reason IS NOT NULL))
);
CREATE TABLE arco_evm."StocksTradingLimitEvent" (
  id TEXT PRIMARY KEY,
  "deploymentDigest" TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  "expectedVersion" INTEGER NOT NULL CHECK ("expectedVersion" >= 0 AND "expectedVersion" < 2147483647 AND version="expectedVersion"+1),
  "previousEnabled" BOOLEAN NOT NULL,
  "previousDailyCashLimit" NUMERIC,
  enabled BOOLEAN NOT NULL,
  "dailyCashLimit" NUMERIC CHECK ("dailyCashLimit" IS NULL OR ("dailyCashLimit"=trunc("dailyCashLimit") AND "dailyCashLimit">0 AND "dailyCashLimit"<=1e30)),
  "operatorId" TEXT NOT NULL CHECK (char_length("operatorId") BETWEEN 1 AND 128 AND "operatorId"=btrim("operatorId") AND "operatorId" !~ '[[:cntrl:]]'),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500 AND reason=btrim(reason) AND reason !~ '[[:cntrl:]]'),
  "idempotencyKey" TEXT NOT NULL CHECK ("idempotencyKey" ~ '^[a-zA-Z0-9:_-]{8,128}$'),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY ("deploymentDigest", symbol, side) REFERENCES arco_evm."StocksTradingLimit"("deploymentDigest", symbol, side) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE ("deploymentDigest", symbol, side, version),
  UNIQUE ("deploymentDigest", "idempotencyKey")
);

CREATE FUNCTION arco_evm.stocks_trading_limit_state_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE change arco_evm."StocksTradingLimitEvent"%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' OR TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'LIMIT_DELETE_FORBIDDEN'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>0 OR NOT NEW.enabled OR NEW."dailyCashLimit" IS NOT NULL OR NEW."updatedAt" IS NOT NULL OR NEW."operatorId" IS NOT NULL OR NEW.reason IS NOT NULL THEN
      RAISE EXCEPTION 'LIMIT_INITIAL_STATE_INVALID';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."deploymentDigest" IS DISTINCT FROM OLD."deploymentDigest" OR NEW.symbol IS DISTINCT FROM OLD.symbol OR NEW.side IS DISTINCT FROM OLD.side
     OR OLD.version=2147483647 OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'LIMIT_VERSION_REGRESSION';
  END IF;
  SELECT * INTO change FROM arco_evm."StocksTradingLimitEvent" WHERE "deploymentDigest"=OLD."deploymentDigest" AND symbol=OLD.symbol AND side=OLD.side AND version=NEW.version;
  IF NOT FOUND OR change."expectedVersion"<>OLD.version OR change."previousEnabled" IS DISTINCT FROM OLD.enabled OR
     change."previousDailyCashLimit" IS DISTINCT FROM OLD."dailyCashLimit" OR NEW.enabled IS DISTINCT FROM change.enabled OR
     NEW."dailyCashLimit" IS DISTINCT FROM change."dailyCashLimit" OR NEW."operatorId" IS DISTINCT FROM change."operatorId" OR
     NEW.reason IS DISTINCT FROM change.reason OR NEW."updatedAt" IS DISTINCT FROM change."createdAt" THEN
    RAISE EXCEPTION 'LIMIT_EVENT_MISMATCH';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "StocksTradingLimit_guard" BEFORE INSERT OR UPDATE OR DELETE ON arco_evm."StocksTradingLimit" FOR EACH ROW EXECUTE FUNCTION arco_evm.stocks_trading_limit_state_guard();
CREATE TRIGGER "StocksTradingLimit_no_truncate" BEFORE TRUNCATE ON arco_evm."StocksTradingLimit" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm.stocks_trading_limit_state_guard();

CREATE FUNCTION arco_evm.stocks_trading_limit_event_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE current_state arco_evm."StocksTradingLimit"%ROWTYPE;
BEGIN
  SELECT * INTO current_state FROM arco_evm."StocksTradingLimit" WHERE "deploymentDigest"=NEW."deploymentDigest" AND symbol=NEW.symbol AND side=NEW.side FOR UPDATE;
  IF NOT FOUND OR NEW."expectedVersion"<>current_state.version OR NEW."previousEnabled" IS DISTINCT FROM current_state.enabled OR
     NEW."previousDailyCashLimit" IS DISTINCT FROM current_state."dailyCashLimit" THEN
    RAISE EXCEPTION 'LIMIT_EVENT_MISMATCH';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "StocksTradingLimitEvent_binding" BEFORE INSERT ON arco_evm."StocksTradingLimitEvent" FOR EACH ROW EXECUTE FUNCTION arco_evm.stocks_trading_limit_event_guard();
CREATE TRIGGER "StocksTradingLimitEvent_immutable" BEFORE UPDATE OR DELETE ON arco_evm."StocksTradingLimitEvent" FOR EACH ROW EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE TRIGGER "StocksTradingLimitEvent_no_truncate" BEFORE TRUNCATE ON arco_evm."StocksTradingLimitEvent" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm."StocksRejectMutation"();

-- Even a direct event INSERT must update the state row before committing.
CREATE FUNCTION arco_evm.stocks_trading_limit_event_applied() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM arco_evm."StocksTradingLimit" WHERE "deploymentDigest"=NEW."deploymentDigest" AND symbol=NEW.symbol AND side=NEW.side AND version>=NEW.version) THEN
    RAISE EXCEPTION 'LIMIT_EVENT_NOT_APPLIED';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER "StocksTradingLimitEvent_applied" AFTER INSERT ON arco_evm."StocksTradingLimitEvent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION arco_evm.stocks_trading_limit_event_applied();

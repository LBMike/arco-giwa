-- A missing row means paused. No existing deployment is enabled or backfilled.
CREATE TABLE arco_evm."StocksTradingControl" (
  "deploymentDigest" TEXT PRIMARY KEY CHECK ("deploymentDigest" ~ '^[0-9a-f]{64}$'),
  paused BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  "updatedAt" TIMESTAMPTZ,
  "operatorId" TEXT,
  reason TEXT,
  CHECK ((version=0 AND paused AND "updatedAt" IS NULL AND "operatorId" IS NULL AND reason IS NULL) OR
         (version>0 AND "updatedAt" IS NOT NULL AND "operatorId" IS NOT NULL AND reason IS NOT NULL))
);
CREATE TABLE arco_evm."StocksTradingControlEvent" (
  id TEXT PRIMARY KEY,
  "deploymentDigest" TEXT NOT NULL REFERENCES arco_evm."StocksTradingControl"("deploymentDigest") ON UPDATE RESTRICT ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  "expectedVersion" INTEGER NOT NULL CHECK ("expectedVersion" >= 0 AND "expectedVersion" < 2147483647 AND version="expectedVersion"+1),
  "previousPaused" BOOLEAN NOT NULL,
  paused BOOLEAN NOT NULL,
  "operatorId" TEXT NOT NULL CHECK (char_length("operatorId") BETWEEN 1 AND 128 AND "operatorId"=btrim("operatorId") AND "operatorId" !~ '[[:cntrl:]]'),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500 AND reason=btrim(reason) AND reason !~ '[[:cntrl:]]'),
  "idempotencyKey" TEXT NOT NULL CHECK ("idempotencyKey" ~ '^[a-zA-Z0-9:_-]{8,128}$'),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("deploymentDigest", version),
  UNIQUE ("deploymentDigest", "idempotencyKey")
);

CREATE FUNCTION arco_evm.stocks_trading_control_state_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE change arco_evm."StocksTradingControlEvent"%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' OR TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'CONTROL_DELETE_FORBIDDEN'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>0 OR NOT NEW.paused OR NEW."updatedAt" IS NOT NULL OR NEW."operatorId" IS NOT NULL OR NEW.reason IS NOT NULL THEN
      RAISE EXCEPTION 'CONTROL_INITIAL_STATE_INVALID';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."deploymentDigest" IS DISTINCT FROM OLD."deploymentDigest" OR OLD.version=2147483647 OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'CONTROL_VERSION_REGRESSION';
  END IF;
  SELECT * INTO change FROM arco_evm."StocksTradingControlEvent" WHERE "deploymentDigest"=OLD."deploymentDigest" AND version=NEW.version;
  IF NOT FOUND OR change."expectedVersion"<>OLD.version OR change."previousPaused" IS DISTINCT FROM OLD.paused OR
     NEW.paused IS DISTINCT FROM change.paused OR NEW."operatorId" IS DISTINCT FROM change."operatorId" OR
     NEW.reason IS DISTINCT FROM change.reason OR NEW."updatedAt" IS DISTINCT FROM change."createdAt" THEN
    RAISE EXCEPTION 'CONTROL_EVENT_MISMATCH';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "StocksTradingControl_guard" BEFORE INSERT OR UPDATE OR DELETE ON arco_evm."StocksTradingControl" FOR EACH ROW EXECUTE FUNCTION arco_evm.stocks_trading_control_state_guard();
CREATE TRIGGER "StocksTradingControl_no_truncate" BEFORE TRUNCATE ON arco_evm."StocksTradingControl" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm.stocks_trading_control_state_guard();

CREATE FUNCTION arco_evm.stocks_trading_control_event_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE current_state arco_evm."StocksTradingControl"%ROWTYPE;
BEGIN
  SELECT * INTO current_state FROM arco_evm."StocksTradingControl" WHERE "deploymentDigest"=NEW."deploymentDigest" FOR UPDATE;
  IF NOT FOUND OR NEW."expectedVersion"<>current_state.version OR NEW."previousPaused" IS DISTINCT FROM current_state.paused THEN
    RAISE EXCEPTION 'CONTROL_EVENT_MISMATCH';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "StocksTradingControlEvent_binding" BEFORE INSERT ON arco_evm."StocksTradingControlEvent" FOR EACH ROW EXECUTE FUNCTION arco_evm.stocks_trading_control_event_guard();
CREATE TRIGGER "StocksTradingControlEvent_immutable" BEFORE UPDATE OR DELETE ON arco_evm."StocksTradingControlEvent" FOR EACH ROW EXECUTE FUNCTION arco_evm."StocksRejectMutation"();
CREATE TRIGGER "StocksTradingControlEvent_no_truncate" BEFORE TRUNCATE ON arco_evm."StocksTradingControlEvent" FOR EACH STATEMENT EXECUTE FUNCTION arco_evm."StocksRejectMutation"();

-- Even a direct event INSERT must update state before committing. Several valid
-- sequential changes in one transaction are permitted; events remain immutable.
CREATE FUNCTION arco_evm.stocks_trading_control_event_applied() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM arco_evm."StocksTradingControl" WHERE "deploymentDigest"=NEW."deploymentDigest" AND version>=NEW.version) THEN
    RAISE EXCEPTION 'CONTROL_EVENT_NOT_APPLIED';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER "StocksTradingControlEvent_applied" AFTER INSERT ON arco_evm."StocksTradingControlEvent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION arco_evm.stocks_trading_control_event_applied();

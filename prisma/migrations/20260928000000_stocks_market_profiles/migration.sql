-- Public company facts the Stocks market page shows (market cap, shares outstanding, name, logo path, fund assets), as
-- the market data service validated them from Massive. Kept so a server restart does not empty the Mkt Cap column while
-- the free plan refetches all 40 symbols a few a minute. Read and written only when STOCKS_MARKET_PROFILE_STORE=1.
-- Nothing here is secret or per user, and no existing table changes.
CREATE TABLE arco_evm."StocksMarketProfile" (
  scope TEXT NOT NULL CHECK (scope ~ '^[0-9a-f]{64}$'),
  "key" TEXT NOT NULL CHECK ("key" ~ '^(profile|aum|issuer):[A-Z][A-Z0-9.-]{0,13}$'),
  data JSONB NOT NULL CHECK (octet_length(data::text) <= 1048576),
  "fetchedAt" BIGINT NOT NULL CHECK ("fetchedAt" >= 0),
  "sourceTimestamp" BIGINT CHECK ("sourceTimestamp" IS NULL OR "sourceTimestamp" >= 0),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope, "key")
);

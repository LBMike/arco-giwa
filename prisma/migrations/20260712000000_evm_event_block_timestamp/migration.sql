-- Block time of each indexed event, captured from eth_getBlockByNumber at index time so the
-- portfolio Activity feed can show a human date instead of a raw block number (and to unblock
-- calendar-accurate Monitoring v2 trends). Nullable so it is backward-compatible; existing rows
-- are populated by scripts/indexer/backfill-block-timestamps.
ALTER TABLE "arco_evm"."EvmIndexedEvent" ADD COLUMN "blockTimestamp" TIMESTAMPTZ(3);

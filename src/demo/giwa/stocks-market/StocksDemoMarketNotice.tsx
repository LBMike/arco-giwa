import { GIWA_STOCKS_DEMO_MARKET } from "../config"

/** Explicitly identifies the dated synthetic market when the local 4392 service is offline. */
export function StocksDemoMarketNotice() {
  return GIWA_STOCKS_DEMO_MARKET ? <p role="status" className="rounded-lg border border-[var(--color-arco-border)] bg-[var(--color-arco-surface-muted)] px-4 py-3 text-sm text-[var(--color-arco-ink)]">Stocks demo data · synthetic prices and charts from September 16, 2026. Not live market data or trading prices.</p> : null
}

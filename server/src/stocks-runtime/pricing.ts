import { ensure } from '../stocks/contracts.js';
import { FIXED_PRICING, liveStocksPricing, type StocksPricing } from '../stocks/pricing.js';
import { createNvdaLiveReader } from '../stocks-market-data/live-reader.js';
import { configuredStocksMarketClock, configuredStocksMarketData } from '../stocks-market-runtime/config.js';

const BPS = /^(0|[1-9]\d{0,2})$/;

/**
 * How the runtime prices quotes. STOCKS_PRICING unset or FIXED keeps the fixed mock price. ALPACA_LIVE quotes at the live
 * NVDA price the market chart shows (Alpaca IEX, the same reader and session rules as the chart's live snapshot), with
 * STOCKS_MINT_FEE_BPS on Buy and STOCKS_BURN_FEE_BPS on Sell (basis points, default 0). The Alpaca credentials are read
 * from the given environment only and never logged.
 */
export function stocksPricingFromEnvironment(env: NodeJS.ProcessEnv, ports: { fetch?: typeof fetch; now?: () => number } = {}): StocksPricing {
  const mode = env.STOCKS_PRICING ?? 'FIXED';
  ensure(mode === 'FIXED' || mode === 'ALPACA_LIVE', 'STOCKS_PRICING_CONFIGURATION_INVALID', 500);
  if (mode === 'FIXED') return FIXED_PRICING;
  const fee = (value: string | undefined) => {
    ensure(value === undefined || BPS.test(value), 'STOCKS_PRICING_CONFIGURATION_INVALID', 500);
    return BigInt(value ?? '0');
  };
  ensure(env.ALPACA_API_KEY_ID && env.ALPACA_API_SECRET_KEY, 'STOCKS_PRICING_CONFIGURATION_INVALID', 500);
  const source: NodeJS.ProcessEnv = {
    STOCKS_MARKET_DATA_PROVIDER: 'ALPACA',
    ALPACA_DATA_FEED: 'iex',
    STOCKS_MARKET_DATA_FEED_DELAY: 'REALTIME',
    ALPACA_API_KEY_ID: env.ALPACA_API_KEY_ID,
    ALPACA_API_SECRET_KEY: env.ALPACA_API_SECRET_KEY,
  };
  const marketData = configuredStocksMarketData(source, { fetch: ports.fetch, now: ports.now, requestsPerMinute: 60 });
  const marketClock = configuredStocksMarketClock(source, ports);
  const read = createNvdaLiveReader({ marketData, marketClock, now: ports.now });
  return liveStocksPricing(read, { mintFeeBps: fee(env.STOCKS_MINT_FEE_BPS), burnFeeBps: fee(env.STOCKS_BURN_FEE_BPS) });
}

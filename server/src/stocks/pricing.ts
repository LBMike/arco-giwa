import { ensure, StocksError } from './contracts.js';

/**
 * What a Stocks quote costs or pays. Prices are tUSDC base units (6 decimals) per whole NVDA; quantities are NVDA base
 * units (9 decimals). The demo began with one fixed mock price (120 tUSDC, no fees), which stays the default for tests
 * and offline tools. The local customer runtime quotes at the live NVDA price its chart shows (see
 * stocks-runtime/pricing.ts), with a mint fee on Buy and a burn fee on Sell, both 0 for now.
 *
 * A quote records its own cash amount; later steps (order, deposit, mint, payout) use that recorded amount and never
 * price the order again.
 */
export type StocksPricing = Readonly<{
  /** The current price. Throws a StocksError (503 PRICE_UNAVAILABLE) when there is no usable price. */
  price(): Promise<bigint>;
  /** Buy fee in basis points of what the wallet pays (10 = 0.1%). */
  mintFeeBps: bigint;
  /** Sell fee in basis points of the sale's value (10 = 0.1%). */
  burnFeeBps: bigint;
}>;

const BPS = 10_000n;
const UNIT = 1_000_000_000n;
const MAX_PRICE = 10n ** 13n; // 10,000,000 tUSDC per NVDA
export const FIXED_PRICE = 120_000_000n;
export const FIXED_PRICING: StocksPricing = Object.freeze({ price: async () => FIXED_PRICE, mintFeeBps: 0n, burnFeeBps: 0n });

export function feeBps(value: bigint): bigint {
  ensure(typeof value === 'bigint' && value >= 0n && value < 1_000n, 'INVALID_PRICING', 500);
  return value;
}

/** tUSDC a Buy of `quantity` costs: its value at `price` plus the mint fee, rounded up. */
export function buyCost(quantity: bigint, price: bigint, mintFeeBps: bigint): bigint {
  const net = BPS - feeBps(mintFeeBps);
  return (quantity * price * BPS + net * UNIT - 1n) / (net * UNIT);
}

/** NVDA an exact tUSDC payment buys: the payment less the mint fee, at `price`, rounded down. buyCost of it never exceeds the payment. */
export function buyQuantity(cash: bigint, price: bigint, mintFeeBps: bigint): bigint {
  return (cash * (BPS - feeBps(mintFeeBps)) * UNIT) / (BPS * price);
}

/** tUSDC a Sell of `quantity` pays: its value at `price` less the burn fee, rounded down. */
export function sellPayout(quantity: bigint, price: bigint, burnFeeBps: bigint): bigint {
  return (quantity * price * (BPS - feeBps(burnFeeBps))) / (BPS * UNIT);
}

/** A market price ("223.71", "223.705") as tUSDC base units, rounded half up to 6 decimals. */
export function priceUnits(value: unknown): bigint {
  ensure(typeof value === 'string' && /^(0|[1-9]\d{0,9})(\.\d{1,18})?$/.test(value), 'PRICE_UNAVAILABLE', 503);
  const [whole, fraction = ''] = (value as string).split('.');
  let units = BigInt(whole) * 1_000_000n + BigInt(fraction.slice(0, 6).padEnd(6, '0'));
  if (fraction.length > 6 && fraction[6] >= '5') units += 1n;
  ensure(units > 0n && units <= MAX_PRICE, 'PRICE_UNAVAILABLE', 503);
  return units;
}

/** tUSDC base units as the catalog's 6-decimal price ("223.710000"). */
export function formatPriceUnits(units: bigint): string {
  ensure(units > 0n && units <= MAX_PRICE, 'PRICE_UNAVAILABLE', 503);
  const text = units.toString().padStart(7, '0');
  return `${text.slice(0, -6)}.${text.slice(-6)}`;
}

/** The part of the NVDA display snapshot pricing reads: the underlying price and whether it is a usable observation. */
export type LivePriceSnapshot = { underlying: { price: string | null; status: string } };

/**
 * Quotes at the live price the chart shows. A current observation (AVAILABLE) or the last one while the market is closed
 * (STALE) is used as it is; anything else, a failed read or no answer within `timeoutMs` stops the quote.
 */
export function liveStocksPricing(read: () => Promise<LivePriceSnapshot>, fees: { mintFeeBps: bigint; burnFeeBps: bigint }, timeoutMs = 5_000): StocksPricing {
  feeBps(fees.mintFeeBps);
  feeBps(fees.burnFeeBps);
  return Object.freeze({
    async price() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let snapshot: LivePriceSnapshot;
      try {
        snapshot = await Promise.race([
          Promise.resolve().then(read),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('PRICE_TIMEOUT')), timeoutMs); }),
        ]);
      } catch {
        throw new StocksError('PRICE_UNAVAILABLE', 503);
      } finally {
        clearTimeout(timer);
      }
      const row = snapshot?.underlying;
      ensure(row && (row.status === 'AVAILABLE' || row.status === 'STALE'), 'PRICE_UNAVAILABLE', 503);
      return priceUnits(row.price);
    },
    mintFeeBps: fees.mintFeeBps,
    burnFeeBps: fees.burnFeeBps,
  });
}

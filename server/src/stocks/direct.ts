// Direct orders: the wallet's own transaction is the order, like a Savings or Funds deposit.
//
// A Buy is `depositForOrder(key, tUSDC)` on the funding vault and a Sell is `escrowForOrder(key, NVDA, quantity)` on the
// redemption escrow, both sent by the wallet itself. When the observer sees one whose key carries DIRECT_ORDER_PREFIX and
// no order exists for it yet, the server creates that wallet's order at the live price of that moment, then settles it
// on the unchanged path (broker, mint or redemption). No sign-in is involved: both contracts only take from msg.sender,
// so only the wallet can pay for, or escrow into, its own order. Any other unknown key stays in suspense as before.
import { ensure } from './contracts.js';

/** "ARCODRCT": the first 8 bytes of every direct order key. The other 24 bytes are the browser's random value. */
export const DIRECT_ORDER_PREFIX = '0x4152434f44524354';
const DIRECT_KEY = /^0x4152434f44524354[0-9a-f]{48}$/;

export function isDirectOrderKey(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && DIRECT_KEY.test(value);
}

/** Direct orders have no session actor: the paying wallet is the actor. */
export function directActorId(wallet: string): string {
  return `direct:${wallet.toLowerCase()}`;
}

/** Idempotency key of the order a direct key creates (unique per actor, like every order's). */
export function directIdempotencyKey(orderKey: string): string {
  ensure(isDirectOrderKey(orderKey), 'INVALID_DIRECT_ORDER_KEY', 400);
  return `direct:${orderKey.slice(2)}`;
}

/** Why a direct payment or escrow was not taken as an order; it then waits for review like any unknown key. */
export type DirectHold = 'TRADING_PAUSED' | 'PRICE_UNAVAILABLE' | 'BELOW_ONE_UNIT';

/** How long a direct order waits for a readable price before it is held for review instead of holding up the observer. */
export const DIRECT_PRICE_WAIT_SECONDS = 600n;

/**
 * The live price a direct order is priced at. While its transaction is recent a failed read is rethrown, so the observer
 * reads the transaction again; after DIRECT_PRICE_WAIT_SECONDS the answer is null and the payment is held for review.
 */
export async function directPrice(read: () => Promise<bigint>, blockTimestamp: string, now: number = Date.now()): Promise<bigint | null> {
  try {
    return await read();
  } catch (error) {
    if (BigInt(now) < (BigInt(blockTimestamp) + DIRECT_PRICE_WAIT_SECONDS) * 1000n) throw error;
    return null;
  }
}

/** What a public status read of a direct order shows. Amounts stay integer base-unit strings. */
export type DirectOrderStatus = {
  side: 'BUY' | 'SELL';
  state: string;
  quantity: string;
  cashAmount: string;
  createdAt: string;
  updatedAt: string;
  /** Only on a payment or escrow that was held instead of taken as an order. */
  hold?: DirectHold;
};

/**
 * One Stocks trade in a wallet's public activity: an order the wallet paid for (Buy) or escrowed NVDA into (Sell), or a
 * payment or escrow held for review without an order. Every fact here is on GIWA: `paymentTx` is the wallet's own
 * transaction, `settlementTx` the platform's mint, payout, refund or return once it is done.
 */
export type StocksActivityEntry = {
  side: 'BUY' | 'SELL';
  state: string;
  quantity: string;
  cashAmount: string;
  paymentTx: string;
  settlementTx: string | null;
  createdAt: string;
};

/** How many trades one activity read returns (newest first). */
export const ACTIVITY_LIMIT = 50;

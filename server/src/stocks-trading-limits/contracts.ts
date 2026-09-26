import type { Operator, SqlClient } from '../stocks/contracts.js';

// Per-symbol, per-side trading limits (STOCKS_TRADING_LIMITS=1). Each (symbol, side) has two settings: whether the side
// takes new orders, and an optional cap on the cash all wallets together may trade on that side in one KST day.
// Without a stored row a side is enabled with no cap, so turning the feature on changes nothing until an operator acts.

export const TRADING_SIDES = ['BUY', 'SELL'] as const;
export type TradingSide = (typeof TRADING_SIDES)[number];

/** Why a new order is refused (409) or a direct payment or escrow held instead of becoming an order. */
export type TradingLimitBlock = 'SIDE_DISABLED' | 'DAILY_LIMIT_REACHED';
export const TRADING_LIMIT_BLOCKS: readonly TradingLimitBlock[] = ['SIDE_DISABLED', 'DAILY_LIMIT_REACHED'];

/** The day a cap counts: 00:00 to 24:00 in Asia/Seoul (no daylight saving). */
export const TRADING_LIMIT_TIME_ZONE = 'Asia/Seoul';

export type TradingLimitState = {
  deploymentDigest: string;
  symbol: string;
  side: TradingSide;
  enabled: boolean;
  /** Cash token base units per KST day, all wallets together; null means no cap. */
  dailyCashLimit: string | null;
  version: number;
  updatedAt: string | null;
  operatorId: string | null;
  reason: string | null;
};

/** A limit with the cash base units its side has already taken in the current KST day. */
export type TradingLimitView = TradingLimitState & { usedToday: string };
export type TradingLimitWindow = { start: string; resetsAt: string; timeZone: typeof TRADING_LIMIT_TIME_ZONE };
export type TradingLimitsRead = { items: TradingLimitView[]; window: TradingLimitWindow };

export type TradingLimitCommand = {
  enabled: boolean;
  dailyCashLimit: string | null;
  expectedVersion: number;
  idempotencyKey: string;
  reason: string;
};

export type TradingLimitEvent = {
  id: string;
  deploymentDigest: string;
  symbol: string;
  side: TradingSide;
  version: number;
  previousEnabled: boolean;
  previousDailyCashLimit: string | null;
  enabled: boolean;
  dailyCashLimit: string | null;
  operatorId: string;
  reason: string;
  createdAt: string;
};
export type TradingLimitChange = { state: TradingLimitState; change: TradingLimitEvent; replayed: boolean };
export type TradingLimitHistory = { items: TradingLimitEvent[] };

/** The admin routes' port. */
export type TradingLimitsPort = {
  /** The symbols that can be traded (and so limited) on this deployment. */
  readonly symbols: readonly string[];
  read(): Promise<TradingLimitsRead>;
  change(operator: Operator, symbol: string, side: TradingSide, command: TradingLimitCommand): Promise<TradingLimitChange>;
  history(limit?: number): Promise<TradingLimitHistory>;
};

/** The order path's port (StocksService). */
export type TradingLimitGate = {
  /** Before a quote: no lock. The order check decides. */
  check(symbol: string, side: TradingSide, cash: bigint): Promise<TradingLimitBlock | null>;
  /**
   * Inside the transaction that creates the order: serializes orders of the same (symbol, side) and counts the day's
   * orders, so two concurrent orders can never pass the cap together.
   */
  admit(db: SqlClient, symbol: string, side: TradingSide, cash: bigint): Promise<TradingLimitBlock | null>;
};

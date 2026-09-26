import { randomUUID } from 'node:crypto';
import { ensure, type Operator, type SqlClient, type SqlPool } from '../stocks/contracts.js';
import { validTradingControlText } from '../stocks-trading-control/validation.js';
import {
  TRADING_LIMIT_TIME_ZONE, TRADING_SIDES,
  type TradingLimitBlock, type TradingLimitChange, type TradingLimitCommand, type TradingLimitEvent,
  type TradingLimitGate, type TradingLimitHistory, type TradingLimitsPort, type TradingLimitsRead, type TradingLimitState,
  type TradingLimitView, type TradingSide,
} from './contracts.js';

const INVALID = 'INVALID_TRADING_LIMIT_INPUT';
const MAX_VERSION = 2_147_483_647;
const MAX_CASH = 10n ** 30n;
const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;
type Row = Record<string, any>;
type Queryable = Pick<SqlClient, 'query'>;

/** Start of the current KST day, evaluated by the database so every server instance counts the same day. */
const DAY_START = `(date_trunc('day', clock_timestamp() AT TIME ZONE '${TRADING_LIMIT_TIME_ZONE}') AT TIME ZONE '${TRADING_LIMIT_TIME_ZONE}')`;
/**
 * How long an order whose quote has expired still holds its part of the cap: a payment or escrow sent before expiry
 * may be observed a little later and still settle. Same wait as a direct order's price (DIRECT_PRICE_WAIT_SECONDS).
 */
const RESERVATION_GRACE = `interval '600 seconds'`;
/**
 * Orders of the day that hold part of a side's cap: reserved (awaiting payment or escrow within the grace), in progress
 * or done. Orders that ended without trading (quote expired unpaid, payment or escrow under review, refunded or returned)
 * are left out.
 */
const USAGE: Record<TradingSide, { table: string; awaiting: string; ended: string }> = {
  BUY: { table: 'StocksOrder', awaiting: 'AWAITING_FUNDING', ended: `'FUNDED_QUOTE_EXPIRED','FUNDING_REVIEW_REQUIRED','REFUNDED'` },
  SELL: { table: 'StocksSellOrder', awaiting: 'AWAITING_ESCROW', ended: `'EXPIRED','ESCROW_REVIEW_REQUIRED','RETURN_QUEUED','RETURNED'` },
};

const iso = (value: Date | string): string => new Date(value).toISOString();
const numeric = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

export function isTradingSide(value: unknown): value is TradingSide {
  return value === 'BUY' || value === 'SELL';
}

/** A daily cap in cash base units: a positive integer string up to 10^30, or null for no cap. */
export function validDailyCashLimit(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^[1-9]\d{0,30}$/.test(value) && BigInt(value) <= MAX_CASH);
}

function state(row: Row): TradingLimitState {
  return {
    deploymentDigest: row.deploymentDigest, symbol: row.symbol, side: row.side, enabled: row.enabled, dailyCashLimit: numeric(row.dailyCashLimit),
    version: row.version, updatedAt: row.updatedAt === null ? null : iso(row.updatedAt), operatorId: row.operatorId, reason: row.reason,
  };
}

function event(row: Row): TradingLimitEvent {
  return {
    id: row.id, deploymentDigest: row.deploymentDigest, symbol: row.symbol, side: row.side, version: row.version,
    previousEnabled: row.previousEnabled, previousDailyCashLimit: numeric(row.previousDailyCashLimit),
    enabled: row.enabled, dailyCashLimit: numeric(row.dailyCashLimit), operatorId: row.operatorId, reason: row.reason, createdAt: iso(row.createdAt),
  };
}

export class StocksTradingLimitService implements TradingLimitsPort, TradingLimitGate {
  readonly symbols: readonly string[];

  constructor(private readonly pool: SqlPool, private readonly deploymentDigest: string, symbols: readonly string[]) {
    ensure(typeof deploymentDigest === 'string' && /^[0-9a-f]{64}$/.test(deploymentDigest), INVALID);
    ensure(Array.isArray(symbols) && symbols.length > 0 && symbols.every(symbol => typeof symbol === 'string' && SYMBOL.test(symbol)) && new Set(symbols).size === symbols.length, INVALID);
    this.symbols = Object.freeze([...symbols]);
  }

  private defaults(symbol: string, side: TradingSide): TradingLimitState {
    return { deploymentDigest: this.deploymentDigest, symbol, side, enabled: true, dailyCashLimit: null, version: 0, updatedAt: null, operatorId: null, reason: null };
  }

  private async setting(q: Queryable, symbol: string, side: TradingSide): Promise<{ enabled: boolean; dailyCashLimit: string | null }> {
    const row = (await q.query('SELECT enabled, "dailyCashLimit" FROM arco_evm."StocksTradingLimit" WHERE "deploymentDigest"=$1 AND symbol=$2 AND side=$3', [this.deploymentDigest, symbol, side])).rows[0];
    return row ? { enabled: row.enabled === true, dailyCashLimit: numeric(row.dailyCashLimit) } : { enabled: true, dailyCashLimit: null };
  }

  /** Cash base units the side has taken since `start` (default: the start of the current KST day). */
  private async usage(q: Queryable, symbol: string, side: TradingSide, start?: string): Promise<bigint> {
    const { table, awaiting, ended } = USAGE[side];
    const row = (await q.query(
      `SELECT COALESCE(SUM("cashAmount"),0)::text AS used FROM arco_evm."${table}"
       WHERE "deploymentDigest"=$1 AND symbol=$2 AND "createdAt">=(SELECT COALESCE($3::timestamptz, ${DAY_START}))
         AND state NOT IN (${ended})
         AND NOT (state='${awaiting}' AND "quoteExpiresAt"<=clock_timestamp()-${RESERVATION_GRACE})`,
      [this.deploymentDigest, symbol, start ?? null],
    )).rows[0];
    return BigInt(row?.used ?? '0');
  }

  private async decide(q: Queryable, symbol: string, side: TradingSide, cash: bigint): Promise<TradingLimitBlock | null> {
    ensure(this.symbols.includes(symbol) && isTradingSide(side) && typeof cash === 'bigint' && cash > 0n, INVALID);
    const setting = await this.setting(q, symbol, side);
    if (!setting.enabled) return 'SIDE_DISABLED';
    if (setting.dailyCashLimit === null) return null;
    return (await this.usage(q, symbol, side)) + cash > BigInt(setting.dailyCashLimit) ? 'DAILY_LIMIT_REACHED' : null;
  }

  check(symbol: string, side: TradingSide, cash: bigint): Promise<TradingLimitBlock | null> {
    return this.decide(this.pool, symbol, side, cash);
  }

  async admit(db: SqlClient, symbol: string, side: TradingSide, cash: bigint): Promise<TradingLimitBlock | null> {
    // Held to commit: the next order of this (symbol, side) counts the day only after this one is written or rolled back.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`stocks-limit:${this.deploymentDigest}:${symbol}:${side}`]);
    return this.decide(db, symbol, side, cash);
  }

  async read(): Promise<TradingLimitsRead> {
    const [rows, window] = await Promise.all([
      this.pool.query('SELECT * FROM arco_evm."StocksTradingLimit" WHERE "deploymentDigest"=$1', [this.deploymentDigest]),
      // Asia/Seoul has no daylight saving: its day is 24 hours whatever the session time zone ('1 day' would follow the session's).
      this.pool.query(`SELECT ${DAY_START} AS start, ${DAY_START} + interval '24 hours' AS "resetsAt"`),
    ]);
    const start = iso(window.rows[0].start), resetsAt = iso(window.rows[0].resetsAt);
    const stored = new Map(rows.rows.map(row => [`${row.symbol}:${row.side}`, state(row)] as const));
    const items: TradingLimitView[] = [];
    for (const symbol of this.symbols) {
      for (const side of TRADING_SIDES) {
        const current = stored.get(`${symbol}:${side}`) ?? this.defaults(symbol, side);
        items.push({ ...current, usedToday: (await this.usage(this.pool, symbol, side, start)).toString() });
      }
    }
    return { items, window: { start, resetsAt, timeZone: TRADING_LIMIT_TIME_ZONE } };
  }

  async change(operator: Operator, symbol: string, side: TradingSide, command: TradingLimitCommand): Promise<TradingLimitChange> {
    ensure(operator && validTradingControlText(operator.operatorId, 128) && Array.isArray(operator.permissions) && operator.permissions.includes('stocks:control'), 'OPERATOR_FORBIDDEN', 403);
    const operatorId = operator.operatorId;
    ensure(typeof symbol === 'string' && this.symbols.includes(symbol) && isTradingSide(side), INVALID);
    ensure(command && typeof command === 'object' && !Array.isArray(command) && Object.keys(command).length === 5
      && ['enabled', 'dailyCashLimit', 'expectedVersion', 'idempotencyKey', 'reason'].every(key => Object.prototype.hasOwnProperty.call(command, key)), INVALID);
    const { enabled, dailyCashLimit, expectedVersion, idempotencyKey, reason } = command;
    ensure(typeof enabled === 'boolean' && validDailyCashLimit(dailyCashLimit) && Number.isInteger(expectedVersion) && expectedVersion >= 0 && expectedVersion <= MAX_VERSION - 1
      && typeof idempotencyKey === 'string' && /^[a-zA-Z0-9:_-]{8,128}$/.test(idempotencyKey) && validTradingControlText(reason, 500), INVALID);
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      // The first writer creates the default row (enabled, no cap); reads never create state.
      await db.query('INSERT INTO arco_evm."StocksTradingLimit" ("deploymentDigest",symbol,side) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [this.deploymentDigest, symbol, side]);
      const current = (await db.query('SELECT * FROM arco_evm."StocksTradingLimit" WHERE "deploymentDigest"=$1 AND symbol=$2 AND side=$3 FOR UPDATE', [this.deploymentDigest, symbol, side])).rows[0];
      const previous = (await db.query('SELECT * FROM arco_evm."StocksTradingLimitEvent" WHERE "deploymentDigest"=$1 AND "idempotencyKey"=$2', [this.deploymentDigest, idempotencyKey])).rows[0];
      if (previous) {
        ensure(previous.symbol === symbol && previous.side === side && previous.operatorId === operatorId && previous.enabled === enabled
          && numeric(previous.dailyCashLimit) === dailyCashLimit && previous.expectedVersion === expectedVersion && previous.reason === reason, 'LIMIT_IDEMPOTENCY_CONFLICT', 409);
        await db.query('COMMIT');
        return { state: state(current), change: event(previous), replayed: true };
      }
      ensure(current.version === expectedVersion, 'LIMIT_VERSION_CONFLICT', 409);
      const next = (await db.query(
        'INSERT INTO arco_evm."StocksTradingLimitEvent" (id,"deploymentDigest",symbol,side,version,"expectedVersion","previousEnabled","previousDailyCashLimit",enabled,"dailyCashLimit","operatorId",reason,"idempotencyKey") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
        [randomUUID(), this.deploymentDigest, symbol, side, current.version + 1, expectedVersion, current.enabled, numeric(current.dailyCashLimit), enabled, dailyCashLimit, operatorId, reason, idempotencyKey],
      )).rows[0];
      // The event's own timestamp, in SQL, so the microseconds match exactly (the state guard compares them).
      const updated = (await db.query(
        'UPDATE arco_evm."StocksTradingLimit" SET enabled=$4,"dailyCashLimit"=$5,version=$6,"operatorId"=$7,reason=$8,"updatedAt"=(SELECT "createdAt" FROM arco_evm."StocksTradingLimitEvent" WHERE id=$9) WHERE "deploymentDigest"=$1 AND symbol=$2 AND side=$3 RETURNING *',
        [this.deploymentDigest, symbol, side, enabled, dailyCashLimit, next.version, operatorId, reason, next.id],
      )).rows[0];
      await db.query('COMMIT');
      return { state: state(updated), change: event(next), replayed: false };
    } catch (error) {
      try { await db.query('ROLLBACK'); } catch { /* preserve the original failure */ }
      throw error;
    } finally { db.release(); }
  }

  async history(limit = 50): Promise<TradingLimitHistory> {
    ensure(Number.isInteger(limit) && limit >= 1 && limit <= 100, INVALID);
    const rows = (await this.pool.query('SELECT * FROM arco_evm."StocksTradingLimitEvent" WHERE "deploymentDigest"=$1 ORDER BY "createdAt" DESC, id DESC LIMIT $2', [this.deploymentDigest, limit])).rows;
    return { items: rows.map(event) };
  }
}

import { randomUUID } from 'node:crypto';
import { ensure, type Operator, type SqlPool } from '../stocks/contracts.js';
import type { TradingControlChange, TradingControlCommand, TradingControlEvent, TradingControlHistory, TradingControlPort, TradingControlState } from './contracts.js';
import { validTradingControlText } from './validation.js';

const invalid = 'INVALID_TRADING_CONTROL_INPUT';
type Row = Record<string, any>;
const iso = (value: Date | string): string => new Date(value).toISOString();
function event(row: Row): TradingControlEvent {
  return { id: row.id, deploymentDigest: row.deploymentDigest, version: row.version, previousPaused: row.previousPaused, paused: row.paused, operatorId: row.operatorId, reason: row.reason, createdAt: iso(row.createdAt) };
}
function state(row: Row): TradingControlState {
  return { deploymentDigest: row.deploymentDigest, paused: row.paused, version: row.version, updatedAt: row.updatedAt === null ? null : iso(row.updatedAt), operatorId: row.operatorId, reason: row.reason };
}

export class StocksTradingControlService implements TradingControlPort {
  constructor(private readonly pool: SqlPool, private readonly deploymentDigest: string) {
    ensure(typeof deploymentDigest === 'string' && /^[0-9a-f]{64}$/.test(deploymentDigest), invalid);
  }
  async read(): Promise<TradingControlState> {
    const row = (await this.pool.query('SELECT * FROM arco_evm."StocksTradingControl" WHERE "deploymentDigest"=$1', [this.deploymentDigest])).rows[0];
    return row ? state(row) : { deploymentDigest: this.deploymentDigest, paused: true, version: 0, updatedAt: null, operatorId: null, reason: null };
  }
  async change(operator: Operator, command: TradingControlCommand): Promise<TradingControlChange> {
    ensure(operator && validTradingControlText(operator.operatorId, 128) && Array.isArray(operator.permissions) && operator.permissions.includes('stocks:control'), 'OPERATOR_FORBIDDEN', 403);
    const operatorId = operator.operatorId;
    ensure(command && typeof command === 'object' && !Array.isArray(command) && Object.keys(command).length === 4 && ['paused', 'expectedVersion', 'idempotencyKey', 'reason'].every(key => Object.prototype.hasOwnProperty.call(command, key)), invalid);
    const { paused, expectedVersion, idempotencyKey, reason } = command;
    ensure(typeof paused === 'boolean' && Number.isInteger(expectedVersion) && expectedVersion >= 0 && expectedVersion <= 2147483646 && typeof idempotencyKey === 'string' && /^[a-zA-Z0-9:_-]{8,128}$/.test(idempotencyKey) && validTradingControlText(reason, 500), invalid);
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      // The first writer creates a fail-closed row. Reads never bootstrap state.
      await db.query('INSERT INTO arco_evm."StocksTradingControl" ("deploymentDigest") VALUES($1) ON CONFLICT DO NOTHING', [this.deploymentDigest]);
      const current = (await db.query('SELECT * FROM arco_evm."StocksTradingControl" WHERE "deploymentDigest"=$1 FOR UPDATE', [this.deploymentDigest])).rows[0];
      const previous = (await db.query('SELECT * FROM arco_evm."StocksTradingControlEvent" WHERE "deploymentDigest"=$1 AND "idempotencyKey"=$2', [this.deploymentDigest, idempotencyKey])).rows[0];
      if (previous) {
        ensure(previous.operatorId === operatorId && previous.paused === paused && previous.expectedVersion === expectedVersion && previous.reason === reason, 'CONTROL_IDEMPOTENCY_CONFLICT', 409);
        await db.query('COMMIT');
        return { state: state(current), change: event(previous), replayed: true };
      }
      ensure(current.version === expectedVersion, 'CONTROL_VERSION_CONFLICT', 409);
      const next = (await db.query('INSERT INTO arco_evm."StocksTradingControlEvent" (id,"deploymentDigest",version,"expectedVersion","previousPaused",paused,"operatorId",reason,"idempotencyKey") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [randomUUID(), this.deploymentDigest, current.version + 1, expectedVersion, current.paused, paused, operatorId, reason, idempotencyKey])).rows[0];
      // Use the event timestamp in SQL so PostgreSQL microseconds remain identical.
      const updated = (await db.query('UPDATE arco_evm."StocksTradingControl" SET paused=$2,version=$3,"operatorId"=$4,reason=$5,"updatedAt"=(SELECT "createdAt" FROM arco_evm."StocksTradingControlEvent" WHERE id=$6) WHERE "deploymentDigest"=$1 RETURNING *', [this.deploymentDigest, paused, next.version, operatorId, reason, next.id])).rows[0];
      await db.query('COMMIT');
      return { state: state(updated), change: event(next), replayed: false };
    } catch (error) {
      try { await db.query('ROLLBACK'); } catch { /* preserve the original failure */ }
      throw error;
    } finally { db.release(); }
  }
  async history(limit = 50, beforeVersion?: number): Promise<TradingControlHistory> {
    ensure(Number.isInteger(limit) && limit >= 1 && limit <= 100 && (beforeVersion === undefined || (Number.isInteger(beforeVersion) && beforeVersion > 0 && beforeVersion <= 2147483647)), invalid);
    const rows = (await this.pool.query('SELECT * FROM arco_evm."StocksTradingControlEvent" WHERE "deploymentDigest"=$1 AND ($2::integer IS NULL OR version<$2) ORDER BY version DESC LIMIT $3', [this.deploymentDigest, beforeVersion ?? null, limit + 1])).rows;
    const items = rows.slice(0, limit).map(event);
    return { items, nextBeforeVersion: rows.length > limit ? items[items.length - 1].version : null };
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { StocksError, type Operator, type SqlPool } from '../stocks/contracts.js';
import { StocksTradingControlService } from './service.js';
import type { TradingControlCommand } from './contracts.js';

const operator: Operator = { operatorId: 'operator:alice', permissions: ['stocks:control'] };
const command: TradingControlCommand = { paused: false, expectedVersion: 0, idempotencyKey: 'control:key', reason: 'Verified deployment' };
function fixture() {
  let calls = 0;
  const pool: SqlPool = { query: async () => { calls++; throw new Error('DATABASE_MUST_NOT_BE_USED'); }, connect: async () => { calls++; throw new Error('DATABASE_MUST_NOT_BE_USED'); } };
  return { service: new StocksTradingControlService(pool, 'a'.repeat(64)), calls: () => calls };
}
const failure = (code: string, status: number) => (error: unknown) => error instanceof StocksError && error.code === code && error.status === status;

test('trading control rejects invalid named operators before command or DB access', async () => {
  const f = fixture();
  for (const value of [null, {}, { ...operator, operatorId: '' }, { ...operator, operatorId: ' alice' }, { ...operator, operatorId: 'alice\n' }, { ...operator, operatorId: 'a'.repeat(129) }, { ...operator, permissions: ['stocks:read'] }, { ...operator, permissions: 'stocks:control' }]) {
    await assert.rejects(f.service.change(value as Operator, null as unknown as TradingControlCommand), failure('OPERATOR_FORBIDDEN', 403));
  }
  assert.equal(f.calls(), 0);
});

test('trading control commands are exact and bounded without input normalization', async () => {
  const f = fixture();
  for (const patch of [{ paused: 0 }, { paused: 'false' }, { expectedVersion: -1 }, { expectedVersion: 0.1 }, { expectedVersion: NaN }, { expectedVersion: 2147483647 }, { idempotencyKey: 'short' }, { idempotencyKey: 'a'.repeat(129) }, { idempotencyKey: 'bad key!' }, { reason: '' }, { reason: ' padded' }, { reason: 'padded ' }, { reason: 'line\nbreak' }, { reason: 'control\u0085character' }, { reason: 'a'.repeat(501) }, { extra: true }]) {
    await assert.rejects(f.service.change(operator, { ...command, ...patch } as TradingControlCommand), failure('INVALID_TRADING_CONTROL_INPUT', 400));
  }
  for (const value of [null, [], {}, { ...command, reason: undefined }]) await assert.rejects(f.service.change(operator, value as TradingControlCommand), failure('INVALID_TRADING_CONTROL_INPUT', 400));
  assert.equal(f.calls(), 0);
});

test('trading control history rejects malformed limits and cursors without DB access', async () => {
  const f = fixture();
  for (const limit of [0, -1, 101, 1.1, NaN, Infinity, null, '50']) await assert.rejects(f.service.history(limit as number), failure('INVALID_TRADING_CONTROL_INPUT', 400));
  for (const before of [0, -1, 1.1, NaN, Infinity, 2147483648, null, '1']) await assert.rejects(f.service.history(50, before as number), failure('INVALID_TRADING_CONTROL_INPUT', 400));
  assert.equal(f.calls(), 0);
});

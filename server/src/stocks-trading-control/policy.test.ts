import assert from 'node:assert/strict';
import test from 'node:test';
import type { Operator } from '../stocks/contracts.js';
import type { TradingControlCommand, TradingControlPort, TradingControlState } from './contracts.js';
import { CONTROL_SNAPSHOT_MAX_AGE_MS, StocksTradingControlPolicy } from './policy.js';

const digest = 'a'.repeat(64);
const operator: Operator = { operatorId: 'policy-operator', permissions: ['stocks:control'] };
const command: TradingControlCommand = { paused: true, expectedVersion: 1, idempotencyKey: 'policy-pause-001', reason: 'Policy test pause' };
function state(paused = false, version = 1, patch: Partial<TradingControlState> = {}): TradingControlState {
  return { deploymentDigest: digest, paused, version, updatedAt: '2026-09-19T00:00:00.000Z', operatorId: operator.operatorId, reason: 'Policy test', ...patch };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  let wall = 100_000, mono = 100, reads = 0;
  let read: () => Promise<TradingControlState> = async () => state();
  let change: TradingControlPort['change'] = async (_operator, input) => {
    const next = state(input.paused, input.expectedVersion + 1);
    return { state: next, change: { id: 'policy-event', deploymentDigest: digest, version: next.version, previousPaused: !next.paused, paused: next.paused, operatorId: operator.operatorId, reason: input.reason, createdAt: next.updatedAt! }, replayed: false };
  };
  const historyCalls: Array<[number | undefined, number | undefined]> = [];
  const source: TradingControlPort = {
    read: async () => { reads++; return read(); },
    change: (named, input) => change(named, input),
    history: async (limit, before) => { historyCalls.push([limit, before]); return { items: [], nextBeforeVersion: null }; },
  };
  const policy = new StocksTradingControlPolicy(source, digest, () => wall, () => mono);
  return { policy, reads: () => reads, historyCalls, read: (fn: typeof read) => { read = fn; }, change: (fn: typeof change) => { change = fn; },
    advance: (ms: number) => { wall += ms; mono += ms; }, wall: (value: number) => { wall = value; }, mono: (value: number) => { mono = value; } };
}

test('every admission reads the database while synchronous diagnostics never do', async () => {
  const f = fixture();
  assert.deepEqual(f.policy.snapshot(), { status: 'UNAVAILABLE', version: null });
  assert.equal(f.reads(), 0);
  assert.equal(await f.policy.isPaused(), false);
  assert.equal(await f.policy.isPaused(), false);
  assert.equal(f.reads(), 2);
  f.read(async () => state(true, 2));
  assert.equal(await f.policy.isPaused(), true);
  assert.equal(f.reads(), 3);
  assert.deepEqual(f.policy.snapshot(), { status: 'PAUSED', version: 2 });
  assert.equal(f.reads(), 3);
});

test('a failed admission is closed and fresh successful reads recover without cached authorization', async () => {
  const f = fixture();
  assert.equal(await f.policy.isPaused(), false);
  f.read(async () => { throw new Error('PRIVATE_DATABASE_FAILURE'); });
  assert.equal(await f.policy.isPaused(), true);
  assert.deepEqual(f.policy.snapshot(), { status: 'UNAVAILABLE', version: null });
  f.read(async () => state(false, 2));
  assert.equal(await f.policy.isPaused(), false);
  assert.deepEqual(f.policy.snapshot(), { status: 'RESUMED', version: 2 });
});

for (const clock of ['wall', 'mono', 'both'] as const) test(`diagnostic expiry on ${clock} cannot revive merely when clocks return`, async () => {
  const f = fixture(); await f.policy.read(); f.advance(CONTROL_SNAPSHOT_MAX_AGE_MS);
  assert.deepEqual(f.policy.snapshot(), { status: 'RESUMED', version: 1 });
  if (clock === 'wall') f.wall(105001); else if (clock === 'mono') f.mono(5101); else f.advance(1);
  assert.deepEqual(f.policy.snapshot(), { status: 'UNAVAILABLE', version: null });
  f.wall(100001); f.mono(101);
  assert.deepEqual(f.policy.snapshot(), { status: 'UNAVAILABLE', version: null });
  assert.equal(f.reads(), 1);
  assert.equal(await f.policy.isPaused(), false);
  assert.equal(f.reads(), 2);
});

for (const clock of ['wall', 'mono', 'both'] as const) test(`clock rollback on ${clock} invalidates the diagnostic and admission read`, async () => {
  const f = fixture(); await f.policy.read();
  if (clock !== 'mono') f.wall(99999); if (clock !== 'wall') f.mono(99);
  assert.deepEqual(f.policy.snapshot(), { status: 'UNAVAILABLE', version: null });
  f.wall(100000); f.mono(100);
  const pending = deferred<TradingControlState>(); f.read(() => pending.promise);
  const admission = f.policy.isPaused();
  if (clock !== 'mono') f.wall(99999); if (clock !== 'wall') f.mono(99);
  pending.resolve(state()); assert.equal(await admission, true);
});

for (const clock of ['wall', 'mono', 'both'] as const) test(`a slow read is not admission evidence when ${clock} exceeds the age limit`, async () => {
  const f = fixture(), pending = deferred<TradingControlState>(); f.read(() => pending.promise);
  const admission = f.policy.isPaused();
  if (clock !== 'mono') f.wall(105001); if (clock !== 'wall') f.mono(5101);
  pending.resolve(state()); assert.equal(await admission, true);
  assert.deepEqual(f.policy.snapshot(), { status: 'UNAVAILABLE', version: null });
});

test('nonfinite clocks cannot authorize even when the other clock is valid', async () => {
  for (const clock of ['wall', 'mono'] as const) for (const bad of [NaN, Infinity, -Infinity]) {
    const f = fixture(); f[clock](bad);
    assert.equal(await f.policy.isPaused(), true);
    assert.deepEqual(f.policy.snapshot(), { status: 'UNAVAILABLE', version: null });
  }
});

test('a read begun before a locally acknowledged pause cannot authorize or replace it', async () => {
  const f = fixture(), pending = deferred<TradingControlState>(); f.read(() => pending.promise);
  const admission = f.policy.isPaused();
  const changed = await f.policy.change(operator, command);
  assert.equal(changed.state.paused, true);
  pending.resolve(state(false, 1));
  assert.equal(await admission, true);
  assert.deepEqual(f.policy.snapshot(), { status: 'PAUSED', version: 2 });
});

test('a newer paused database revision wins even when its read began first and completes last', async () => {
  const f = fixture(), old = deferred<TradingControlState>(), recent = deferred<TradingControlState>();
  let calls = 0; f.read(() => ++calls === 1 ? old.promise : recent.promise);
  const first = f.policy.isPaused(), second = f.policy.isPaused();
  recent.resolve(state(false, 2)); assert.equal(await second, false);
  old.resolve(state(true, 3)); assert.equal(await first, true);
  assert.deepEqual(f.policy.snapshot(), { status: 'PAUSED', version: 3 });
});

test('an older paused read blocks only its own admission and cannot replace a higher resumed diagnostic', async () => {
  const f = fixture(), old = deferred<TradingControlState>(), recent = deferred<TradingControlState>();
  let calls = 0; f.read(() => ++calls === 1 ? old.promise : recent.promise);
  const first = f.policy.isPaused(), second = f.policy.isPaused();
  recent.resolve(state(false, 3)); assert.equal(await second, false);
  old.resolve(state(true, 2)); assert.equal(await first, true);
  assert.deepEqual(f.policy.snapshot(), { status: 'RESUMED', version: 3 });
});

test('an invalid overlapping result cannot borrow a different read authorization', async () => {
  for (const patch of [{ deploymentDigest: 'b'.repeat(64) }, { version: -1 }]) {
    const f = fixture(), old = deferred<TradingControlState>(), recent = deferred<TradingControlState>();
    let calls = 0; f.read(() => ++calls === 1 ? old.promise : recent.promise);
    const first = f.policy.isPaused(), second = f.policy.isPaused();
    recent.resolve(state(false, 2)); assert.equal(await second, false);
    old.resolve(state(false, 1, patch)); assert.equal(await first, true);
  }
});

test('a slow overlapping read cannot borrow a later fresh result', async () => {
  const f = fixture(), old = deferred<TradingControlState>(), recent = deferred<TradingControlState>();
  let calls = 0; f.read(() => ++calls === 1 ? old.promise : recent.promise);
  const first = f.policy.isPaused(); f.advance(5001);
  const second = f.policy.isPaused(); recent.resolve(state(false, 2)); assert.equal(await second, false);
  old.resolve(state(false, 2)); assert.equal(await first, true);
});

test('wrong deployment or malformed state revision cannot authorize', async () => {
  for (const patch of [{ deploymentDigest: 'b'.repeat(64) }, { version: -1 }, { version: 1.5 }, { version: 2147483648 }, { version: NaN }, { version: 0 }, { paused: 'false' as unknown as boolean }]) {
    const f = fixture(); f.read(async () => state(false, 1, patch));
    assert.equal(await f.policy.isPaused(), true, JSON.stringify(patch));
    assert.deepEqual(f.policy.snapshot(), { status: 'UNAVAILABLE', version: null });
  }
});

for (const invalidation of ['older-read', 'database-failure', 'expiry'] as const) test(`highest revision survives ${invalidation} and rejects repeated older resumed reads`, async () => {
  const f = fixture(); f.read(async () => state(true, 8)); assert.equal(await f.policy.isPaused(), true);
  if (invalidation === 'database-failure') { f.read(async () => { throw new Error('offline'); }); assert.equal(await f.policy.isPaused(), true); }
  if (invalidation === 'expiry') { f.advance(5001); assert.deepEqual(f.policy.snapshot(), { status: 'UNAVAILABLE', version: null }); }
  f.read(async () => state(false, 7));
  assert.equal(await f.policy.isPaused(), true); assert.equal(await f.policy.isPaused(), true);
  f.read(async () => state(false, 9)); assert.equal(await f.policy.isPaused(), false);
});

test('contradictory state for one immutable revision cannot authorize until a higher revision is read', async () => {
  const f = fixture(); f.read(async () => state(true, 4)); assert.equal(await f.policy.isPaused(), true);
  f.read(async () => state(false, 4));
  assert.equal(await f.policy.isPaused(), true); assert.equal(await f.policy.isPaused(), true);
  assert.deepEqual(f.policy.snapshot(), { status: 'UNAVAILABLE', version: null });
  f.read(async () => state(false, 5)); assert.equal(await f.policy.isPaused(), false);
});

test('history and failed mutations never manufacture successful admission evidence', async () => {
  const f = fixture();
  assert.deepEqual(await f.policy.history(20, 12), { items: [], nextBeforeVersion: null });
  assert.deepEqual(f.historyCalls, [[20, 12]]); assert.equal(f.reads(), 0);
  f.change(async () => { throw new Error('write failed'); });
  await assert.rejects(f.policy.change(operator, command), /write failed/);
  assert.deepEqual(f.policy.snapshot(), { status: 'UNAVAILABLE', version: null });
});

test('source and returned state references cannot mutate cached evidence or its revision watermark', async () => {
  const f = fixture(), sourceState = state(true, 4); f.read(async () => sourceState);
  const returned = await f.policy.read();
  sourceState.paused = false; sourceState.version = 5;
  returned.paused = false; returned.version = 6;
  assert.deepEqual(f.policy.snapshot(), { status: 'PAUSED', version: 4 });
  f.read(async () => state(false, 3)); assert.equal(await f.policy.isPaused(), true);
  assert.deepEqual(f.policy.snapshot(), { status: 'PAUSED', version: 4 });
});

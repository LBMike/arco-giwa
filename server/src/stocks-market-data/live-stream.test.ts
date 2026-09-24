import assert from 'node:assert/strict';
import test from 'node:test';
import { createSnapshotStreamHub } from './live-stream.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function clock() {
  const ticks = new Set<() => void>();
  let starts = 0;
  let stops = 0;
  let interval = 0;
  return {
    schedule(tick: () => void, intervalMs: number) {
      starts++;
      interval = intervalMs;
      ticks.add(tick);
      return () => { stops++; ticks.delete(tick); };
    },
    tick() { for (const tick of [...ticks]) tick(); },
    get starts() { return starts; },
    get stops() { return stops; },
    get activeTimers() { return ticks.size; },
    get interval() { return interval; },
  };
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('subscribers share one read and timer; new subscribers get an isolated latest snapshot', async () => {
  const timer = clock();
  let reads = 0;
  const hub = createSnapshotStreamHub({
    read: async () => ({ count: ++reads, rows: ['NVDA'] }),
    schedule: timer.schedule,
  });
  const first: { count: number; rows: string[] }[] = [];
  const second: { count: number; rows: string[] }[] = [];
  const offFirst = hub.subscribe(value => { first.push(value); });
  await settle();
  assert.equal(reads, 1);
  assert.equal(timer.starts, 1);
  assert.equal(timer.interval, 30_000);
  const offSecond = hub.subscribe(value => { second.push(value); });
  assert.deepEqual(second, [{ count: 1, rows: ['NVDA'] }]);
  first[0].rows.push('CORRUPTION');
  assert.deepEqual(second[0].rows, ['NVDA']);
  timer.tick();
  await settle();
  assert.equal(reads, 2);
  assert.deepEqual(first.map(value => value.count), [1, 2]);
  assert.deepEqual(second.map(value => value.count), [1, 2]);
  offFirst();
  assert.equal(timer.activeTimers, 1);
  offSecond();
  assert.equal(timer.activeTimers, 0);
  assert.equal(timer.stops, 1);
  timer.tick();
  await hub.refreshNow();
  assert.equal(reads, 2);
});

test('timer ticks and explicit refreshes during an active read are singleflight', async () => {
  const timer = clock();
  const pending: Array<ReturnType<typeof deferred<{ count: number }>>> = [];
  const hub = createSnapshotStreamHub({
    read: () => { const next = deferred<{ count: number }>(); pending.push(next); return next.promise; },
    schedule: timer.schedule,
  });
  const values: number[] = [];
  const off = hub.subscribe(value => { values.push(value.count); });
  const sameRead = Promise.all([hub.refreshNow(), hub.refreshNow()]);
  timer.tick();
  assert.equal(pending.length, 1);
  pending[0].resolve({ count: 1 });
  await sameRead;
  await settle();
  assert.deepEqual(values, [1]);
  assert.equal(pending.length, 1);
  timer.tick();
  assert.equal(pending.length, 2);
  pending[1].resolve({ count: 2 });
  await settle();
  assert.deepEqual(values, [1, 2]);
  off();
});

test('disconnect discards an old in-flight result and reconnect starts a fresh serialized read', async () => {
  const timer = clock();
  const pending: Array<ReturnType<typeof deferred<{ count: number }>>> = [];
  const hub = createSnapshotStreamHub({
    read: () => { const next = deferred<{ count: number }>(); pending.push(next); return next.promise; },
    schedule: timer.schedule,
  });
  const oldValues: number[] = [];
  const newValues: number[] = [];
  const offOld = hub.subscribe(value => { oldValues.push(value.count); });
  assert.equal(pending.length, 1);
  offOld();
  const offNew = hub.subscribe(value => { newValues.push(value.count); });
  assert.equal(pending.length, 1);
  pending[0].resolve({ count: 1 });
  await settle();
  assert.deepEqual(oldValues, []);
  assert.deepEqual(newValues, []);
  assert.equal(pending.length, 2);
  pending[1].resolve({ count: 2 });
  await settle();
  assert.deepEqual(newValues, [2]);
  assert.equal(timer.starts, 2);
  assert.equal(timer.stops, 1);
  offNew();
  assert.equal(timer.stops, 2);
});

test('read failure can recover on the next tick without unhandled rejection', async () => {
  const timer = clock();
  const errors: unknown[] = [];
  let reads = 0;
  const hub = createSnapshotStreamHub({
    read: async () => { if (++reads === 1) throw new Error('provider failed'); return { count: reads }; },
    schedule: timer.schedule,
    onError: error => { errors.push(error); },
  });
  const values: number[] = [];
  const off = hub.subscribe(value => { values.push(value.count); });
  await settle();
  assert.equal(errors.length, 1);
  assert.deepEqual(values, []);
  timer.tick();
  await settle();
  assert.deepEqual(values, [2]);
  off();
});

test('throwing or rejecting listeners are removed so failures cannot repeat indefinitely', async () => {
  const timer = clock();
  const errors: unknown[] = [];
  const hub = createSnapshotStreamHub({
    read: async () => ({ count: 1 }),
    schedule: timer.schedule,
    onError: error => { errors.push(error); },
  });
  hub.subscribe(() => { throw new Error('broken connection'); });
  await settle();
  assert.equal(hub.subscriberCount(), 0);
  assert.equal(timer.activeTimers, 0);
  hub.subscribe(async () => { throw new Error('async broken connection'); });
  await settle();
  assert.equal(hub.subscriberCount(), 0);
  assert.equal(timer.activeTimers, 0);
  assert.equal(errors.length, 2);
});

test('a slow async listener has at most one pending callback', async () => {
  const timer = clock();
  const gate = deferred<void>();
  let reads = 0;
  let callbacks = 0;
  const hub = createSnapshotStreamHub({
    read: async () => ({ count: ++reads }),
    schedule: timer.schedule,
  });
  const off = hub.subscribe(async () => { callbacks++; await gate.promise; });
  await settle();
  timer.tick();
  await settle();
  timer.tick();
  await settle();
  assert.equal(reads, 3);
  assert.equal(callbacks, 1);
  gate.resolve();
  await settle();
  timer.tick();
  await settle();
  assert.equal(callbacks, 2);
  off();
});

test('capacity, close, and invalid configuration fail safely', async () => {
  const timer = clock();
  const reading = deferred<{ count: number }>();
  const hub = createSnapshotStreamHub({ read: () => reading.promise, schedule: timer.schedule, maxSubscribers: 2 });
  const values: number[] = [];
  hub.subscribe(value => { values.push(value.count); });
  hub.subscribe(value => { values.push(value.count); });
  assert.throws(() => hub.subscribe(() => {}), /SNAPSHOT_STREAM_CAPACITY/);
  assert.equal(hub.subscriberCount(), 2);
  hub.close();
  hub.close();
  assert.equal(timer.activeTimers, 0);
  assert.equal(timer.stops, 1);
  reading.resolve({ count: 1 });
  await settle();
  assert.deepEqual(values, []);
  assert.equal(hub.subscriberCount(), 0);
  assert.throws(() => hub.subscribe(() => {}), /SNAPSHOT_STREAM_CLOSED/);
  assert.throws(() => createSnapshotStreamHub({ read: async () => ({}), maxSubscribers: Infinity }), /INVALID_SNAPSHOT_STREAM_CONFIG/);
  assert.throws(() => createSnapshotStreamHub({ read: async () => ({}), intervalMs: 0 }), /INVALID_SNAPSHOT_STREAM_CONFIG/);
});

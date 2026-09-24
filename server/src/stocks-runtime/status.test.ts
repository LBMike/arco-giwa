import assert from 'node:assert/strict';
import test from 'node:test';
import { StocksObservationHealth } from './health.js';
import { runtimeSnapshot } from './status.js';

function fixture() {
  let wall = 100000, mono = 100;
  const health = new StocksObservationHealth(() => wall, () => mono);
  const status = (patch: Partial<Parameters<typeof runtimeSnapshot>[0]> = {}) => runtimeSnapshot({ deploymentId: 'test', deploymentDigest: 'a'.repeat(64), autodispatch: true, configuredPause: false, stopped: false, tickInFlight: false, health: health.snapshot(), ...patch });
  return { health, status, advance: (ms: number) => { wall += ms; mono += ms; }, wall: (value: number) => { wall = value; }, mono: (value: number) => { mono = value; } };
}
test('runtime diagnostic gives deterministic reasons and never execution authorization', () => {
  const f = fixture();
  assert.deepEqual(f.status().pauseReasons, ['OBSERVER_NOT_CURRENT']);
  assert.equal(f.status().lastCurrentAt, null);
  f.health.record('CURRENT');
  assert.equal(f.status().newOrdersPaused, false);
  assert.equal(f.status().executionAuthorization, false);
  assert.deepEqual(f.status({ configuredPause: true }).pauseReasons, ['CONFIGURED_PAUSE']);
  assert.deepEqual(f.status({ autodispatch: false }).pauseReasons, ['AUTODISPATCH_DISABLED']);
  const stopped = f.status({ stopped: true, autodispatch: false, configuredPause: true, tickInFlight: true });
  assert.deepEqual(stopped.pauseReasons, ['RUNTIME_STOPPED', 'AUTODISPATCH_DISABLED', 'CONFIGURED_PAUSE', 'OBSERVER_NOT_CURRENT']);
  assert.equal(stopped.observerStatus, 'STOPPED'); assert.equal(stopped.tickInFlight, true);
});
test('observation expires at the conservative wall/monotonic bound and status reads do not refresh it', () => {
  for (const clock of ['wall', 'mono', 'both']) {
    const f = fixture(); f.health.record('CURRENT');
    const first = f.status(); f.advance(60000);
    assert.equal(f.status().observerStatus, 'CURRENT'); assert.equal(f.status().lastCurrentAgeMs, 60000);
    if (clock === 'wall') f.wall(160001); else if (clock === 'mono') f.mono(60101); else f.advance(1);
    assert.equal(f.status().observerStatus, 'STALE'); assert.equal(f.health.current(), false);
    assert.equal(f.status().lastCurrentAt, first.lastCurrentAt);
    assert.equal(f.status().lastObservationAt, first.lastObservationAt);
  }
});
test('clock reversal and expiry cannot revive an old observation when clocks return', () => {
  for (const clock of ['wall', 'mono']) {
    const f = fixture(); f.health.record('CURRENT'); f.advance(10); assert.equal(f.health.current(), true);
    if (clock === 'wall') f.wall(100005); else f.mono(105);
    assert.equal(f.health.current(), false);
    f.wall(100020); f.mono(120); assert.equal(f.health.current(), false);
    f.health.record('CURRENT'); assert.equal(f.health.current(), true);
  }
  const f = fixture(); f.health.record('CURRENT'); f.advance(60001); assert.equal(f.health.current(), false);
  f.wall(100001); f.mono(101); assert.equal(f.health.current(), false);
});
test('failure preserves historical timestamps but cannot grant current; stop is terminal', () => {
  const f = fixture(); f.health.record('CURRENT'); const original = f.status().lastCurrentAt;
  f.advance(20); f.health.record('WAITING_PROJECTION');
  const failed = f.status(); assert.equal(failed.lastCurrentAt, original); assert.equal(failed.lastCurrentAgeMs, 20);
  assert.notEqual(failed.lastObservationAt, original); assert.equal(failed.newOrdersPaused, true);
  f.health.record('private_error_with_password'); assert.equal(f.status().observerStatus, 'UNAVAILABLE_OR_REVIEW_REQUIRED');
  assert.ok(!JSON.stringify(f.status()).includes('private_error'));
  const lastObservation = f.health.snapshot().lastObservationAt;
  f.advance(1); f.health.record('STOPPED'); f.advance(1); f.health.record('CURRENT'); assert.equal(f.health.status(), 'STOPPED');
  assert.equal(f.health.snapshot().lastObservationAt, lastObservation);
});
test('invalid clocks fail closed without timestamp serialization exceptions in health', () => {
  for (const bad of [NaN, Infinity, -1, 8640000000000001]) {
    const f = fixture(); f.health.record('CURRENT'); f.wall(bad);
    assert.equal(f.health.current(), false); assert.equal(f.health.snapshot().lastCurrentAgeMs, null);
    assert.throws(() => f.status(), /RUNTIME_STATUS_UNAVAILABLE/);
  }
  const f = fixture(); f.mono(NaN); f.health.record('CURRENT'); assert.equal(f.health.current(), false);
});
test('disabled operator control preserves the exact legacy snapshot shape', () => {
  const f = fixture(); f.health.record('CURRENT');
  const legacy = f.status();
  assert.equal(Object.prototype.hasOwnProperty.call(legacy, 'operatorControl'), false);
  assert.deepEqual(f.status({ operatorControl: undefined }), legacy);
});
test('operator control pauses fail closed and resume preserves every independent runtime gate', () => {
  for (const status of ['PAUSED', 'RESUMED', 'UNAVAILABLE'] as const) {
    for (const stopped of [false, true]) for (const autodispatch of [false, true]) for (const configuredPause of [false, true]) for (const current of [false, true]) {
      const f = fixture(); if (current) f.health.record('CURRENT');
      const operatorControl = { status, version: status === 'UNAVAILABLE' ? null : 12 };
      const result = f.status({ operatorControl, stopped, autodispatch, configuredPause });
      const expected = [
        ...(stopped ? ['RUNTIME_STOPPED'] : []),
        ...(!autodispatch ? ['AUTODISPATCH_DISABLED'] : []),
        ...(configuredPause ? ['CONFIGURED_PAUSE'] : []),
        ...(status === 'PAUSED' ? ['OPERATOR_PAUSE'] : []),
        ...(status === 'UNAVAILABLE' ? ['OPERATOR_CONTROL_UNAVAILABLE'] : []),
        ...(!current || stopped ? ['OBSERVER_NOT_CURRENT'] : []),
      ];
      assert.deepEqual(result.operatorControl, operatorControl);
      assert.deepEqual(result.pauseReasons, expected);
      assert.equal(result.newOrdersPaused, expected.length > 0);
      assert.equal(result.executionAuthorization, false);
    }
  }
});
test('operator status copies only public fields without mutating or retaining the cache object', () => {
  const f = fixture(); f.health.record('CURRENT');
  const source = { status: 'PAUSED' as const, version: 3, operatorId: 'PRIVATE_OPERATOR', reason: 'PRIVATE_REASON' };
  Object.defineProperty(source, 'privateGetter', { get() { throw new Error('MUST_NOT_READ'); } });
  const result = f.status({ operatorControl: source });
  assert.deepEqual(result.operatorControl, { status: 'PAUSED', version: 3 });
  assert.notEqual(result.operatorControl, source);
  source.version = 4;
  assert.equal(result.operatorControl?.version, 3);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

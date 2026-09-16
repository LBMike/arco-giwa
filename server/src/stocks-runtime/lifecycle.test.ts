import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import { attachStocksLifecycle, installServerShutdown, startManagedStocksServer, type StocksScheduler } from './lifecycle.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function scheduler() {
  const jobs: (() => void)[] = []; let cancellations = 0;
  const schedule: StocksScheduler = job => { jobs.push(job); return { cancel: () => { cancellations++; } }; };
  return { jobs, schedule, cancellations: () => cancellations };
}
test('Disabled lifecycle starts no work; repeated start and close own one timer and resource', async () => {
  for (const enabled of [false, true]) {
    const app = Fastify(); const timing = scheduler(); let ticks = 0; let closes = 0; let stops = 0;
    const life = attachStocksLifecycle(app, { tick: async () => { ticks++; }, stop: () => { stops++; }, close: async () => { assert.equal(stops, 1); closes++; } }, enabled, timing.schedule);
    await app.ready(); await Promise.all([life.start(), life.start()]);
    assert.equal(ticks, enabled ? 1 : 0); assert.equal(timing.jobs.length, enabled ? 1 : 0);
    await Promise.all([app.close(), life.close(), life.close()]);
    assert.equal(closes, 1); assert.equal(timing.cancellations(), enabled ? 1 : 0);
    timing.jobs.forEach(job => job()); await life.start(); assert.equal(ticks, enabled ? 1 : 0);
  }
});
test('Close during initial tick drains it and never installs a later timer', async () => {
  const app = Fastify(); const timing = scheduler(); const wait = deferred(); const entered = deferred(); let drained = false;
  const life = attachStocksLifecycle(app, { tick: async () => { entered.resolve(); await wait.promise; drained = true; }, close: async () => { await wait.promise; } }, true, timing.schedule);
  await app.ready(); const starting = life.start(); await entered.promise;
  let closed = false; const closing = life.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  wait.resolve(); await Promise.all([starting, closing]);
  assert.equal(drained, true); assert.equal(timing.jobs.length, 0); await app.close();
});
test('A scheduled rejection stops the timer and closes the runtime instead of unhandled rejection or repeated dispatch', async () => {
  const app = Fastify(); const timing = scheduler(); const stopped = deferred(); let ticks = 0;
  const life = attachStocksLifecycle(app, { tick: async () => { if (++ticks > 1) throw new Error('provider unavailable'); }, close: async () => { stopped.resolve(); } }, true, timing.schedule);
  await app.ready(); await life.start(); timing.jobs[0](); await stopped.promise;
  assert.equal(timing.cancellations(), 1); timing.jobs[0](); assert.equal(ticks, 2); await app.close();
});
test('Every partial startup failure closes acquired runtime and database once', async () => {
  for (const failure of ['factory', 'resolver', 'onApp', 'listen', 'firstTick'] as const) {
    let databaseClosed = 0; let runtimeClosed = 0; let listening = false;
    const app = Fastify();
    await assert.rejects(() => startManagedStocksServer({
      createRuntime: async () => {
        if (failure === 'factory') throw new Error(failure);
        return { tick: async () => { if (failure === 'firstTick') throw new Error(failure); }, close: async () => { runtimeClosed++; } };
      },
      buildApp: () => { if (failure === 'resolver') throw new Error(failure); return app; },
      onApp: () => { if (failure === 'onApp') throw new Error(failure); },
      listen: async a => { if (failure === 'listen') throw new Error(failure); await a.ready(); listening = true; },
      closeDatabase: async () => { databaseClosed++; }, autodispatch: true, scheduler: scheduler().schedule,
    }), new RegExp(failure));
    assert.equal(databaseClosed, 1); assert.equal(runtimeClosed, failure === 'factory' ? 0 : 1);
    assert.equal(listening, failure === 'firstTick');
  }
});
test('Server composition without a runtime preserves the listener and closes its database; no-dispatch runtime never ticks', async () => {
  for (const enabled of [false, true]) {
    let ticks = 0; let databaseClosed = 0; let runtimeClosed = 0; const timing = scheduler();
    const app = await startManagedStocksServer({ createRuntime: async () => enabled ? { tick: async () => { ticks++; }, close: async () => { runtimeClosed++; } } : null,
      buildApp: () => { const app = Fastify(); app.get('/health', async () => ({ ok: true })); return app; },
      listen: async app => { await app.ready(); }, closeDatabase: async () => { databaseClosed++; }, autodispatch: false, scheduler: timing.schedule });
    assert.equal((await app.inject('/health')).statusCode, 200); assert.equal(ticks, 0); assert.equal(timing.jobs.length, 0);
    await app.close(); assert.equal(databaseClosed, 1); assert.equal(runtimeClosed, enabled ? 1 : 0);
  }
});
test('CLI signal ownership drains one close and removes listeners; ordinary composition installs none', async () => {
  const host = new EventEmitter() as EventEmitter & { exitCode?: number | string }; const gate = deferred(); const finished = deferred(); let closes = 0;
  const app = Fastify(); installServerShutdown(app, host as unknown as NodeJS.Process);
  app.addHook('onClose', async () => { closes++; await gate.promise; finished.resolve(); }); await app.ready();
  host.emit('SIGTERM'); host.emit('SIGINT'); await Promise.resolve(); gate.resolve(); await finished.promise;
  await app.close(); assert.equal(closes, 1); assert.equal(host.listenerCount('SIGTERM'), 0); assert.equal(host.listenerCount('SIGINT'), 0); assert.equal(host.exitCode, undefined);
});

test('A second signal during blocked resource cleanup remains intercepted until all resources close', async () => {
  const host = new EventEmitter() as EventEmitter & { exitCode?: number | string }; const gate = deferred(); const entered = deferred(); let closes = 0; let databaseClosed = 0;
  const app = await startManagedStocksServer({
    createRuntime: async () => ({ tick: async () => {}, close: async () => { closes++; entered.resolve(); await gate.promise; } }),
    buildApp: () => Fastify(), onApp: app => installServerShutdown(app, host as unknown as NodeJS.Process),
    listen: async app => { await app.ready(); }, closeDatabase: async () => { databaseClosed++; }, autodispatch: true, scheduler: scheduler().schedule,
  });
  host.emit('SIGTERM'); await entered.promise;
  assert.equal(host.listenerCount('SIGTERM'), 1); assert.equal(host.listenerCount('SIGINT'), 1); assert.equal(databaseClosed, 0);
  host.emit('SIGINT'); gate.resolve(); await app.close();
  assert.equal(closes, 1); assert.equal(databaseClosed, 1); assert.equal(host.listenerCount('SIGTERM'), 0); assert.equal(host.listenerCount('SIGINT'), 0);
});

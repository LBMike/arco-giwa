import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { encodeFunctionData, parseAbi } from 'viem';
import { createStocksRuntime, type StocksRuntimeConfig } from './runtime.js';
import { watchStocksPoolErrors } from './database-failure.js';
import { StocksWorker } from '../stocks/worker.js';
import { StocksSellService } from '../stocks/sell-service.js';
import { StocksFinalizedObserver } from './observer.js';
import { manifestDigest } from '../stocks/contracts.js';
import { a, h, testManifest } from '../stocks/test-fixtures.js';
import type { JsonRpcTransport } from '../stocks/rpc.js';
import Fastify from 'fastify';
import { stocksReadinessPlugin } from '../stocks-runtime-status/readiness.js';

async function fixture(t: TestContext, configuredPause = false) {
  const manifest = testManifest() as StocksRuntimeConfig['manifest'], digest = manifestDigest(manifest);
  const words = new Map<string, string>();
  for (const [to, getter, value] of [
    [manifest.stockToken, 'mintController', manifest.mintController], [manifest.stockToken, 'redemptionEscrow', manifest.redemptionEscrow],
    [manifest.fundingVault, 'cashToken', manifest.cashToken], [manifest.fundingVault, 'redemptionEscrow', manifest.redemptionEscrow], [manifest.fundingVault, 'operator', manifest.signerAddress],
    [manifest.mintController, 'stockToken', manifest.stockToken], [manifest.mintController, 'operator', manifest.signerAddress],
    [manifest.redemptionEscrow, 'stockToken', manifest.stockToken], [manifest.redemptionEscrow, 'cashToken', manifest.cashToken],
    [manifest.redemptionEscrow, 'fundingVault', manifest.fundingVault], [manifest.redemptionEscrow, 'operator', manifest.signerAddress],
  ]) words.set(`${to}:${encodeFunctionData({ abi: parseAbi([`function ${getter}() view returns (address)`]), functionName: getter })}`, `0x${value.slice(2).padStart(64, '0')}`);
  const transport: JsonRpcTransport = async (method, params) => {
    if (method === 'eth_chainId') return '0x164ce';
    if (method === 'eth_getBlockByNumber') {
      const number = params[0] === 'finalized' ? '0x64' : String(params[0]);
      return { number, hash: h(Number(BigInt(number))), timestamp: '0x3e8' };
    }
    if (method === 'eth_getCode') return '0x6000';
    if (method === 'eth_call') {
      const tx = params[0] as { to: string; data: string };
      if (tx.data === '0x313ce567') return `0x${(tx.to === manifest.cashToken ? 6 : 9).toString(16).padStart(64, '0')}`;
      const value = words.get(`${tx.to}:${tx.data}`); assert.ok(value); return value;
    }
    assert.fail(`Unexpected RPC ${method}`);
  };
  let ended = 0;
  const pool = Object.assign(new EventEmitter(), {
    async query() { return { rows: [{ deploymentDigest: digest }], rowCount: 1 }; },
    async connect(): Promise<never> { assert.fail('No business transaction expected'); },
    async end() { ended++; pool.emit('error', Error('PRIVATE_SHUTDOWN_CONNECTION')); },
  });
  let observe: () => Promise<'CURRENT' | 'CATCHING_UP'> = async () => 'CURRENT';
  t.mock.method(StocksWorker.prototype, 'runOne', async () => false);
  t.mock.method(StocksSellService.prototype, 'expireReservations', async () => {});
  t.mock.method(StocksFinalizedObserver.prototype, 'runOnce', () => observe());
  let runtime: Awaited<ReturnType<typeof createStocksRuntime>> | undefined;
  watchStocksPoolErrors(pool, () => runtime);
  runtime = await createStocksRuntime({ manifest, pool, transport, autodispatch: true, paused: configuredPause,
    operators: [{ wallet: a(10), operatorId: 'reader', permissions: ['stocks:read'] }],
    signer: { probe: async () => {}, submit: async () => { assert.fail('No signing expected'); }, lookup: async () => null },
  });
  t.after(() => runtime!.close());
  return { runtime, pool, ended: () => ended, observe: (fn: typeof observe) => { observe = fn; } };
}

test('idle-pool failure closes admissions and readiness immediately; a fresh successful tick restores observation', async t => {
  const f = await fixture(t); await f.runtime.tick();
  const app = Fastify(); app.register(stocksReadinessPlugin, { getSnapshot: f.runtime.status }); t.after(() => app.close());
  assert.equal((await app.inject('/ready/stocks')).statusCode, 200);
  assert.equal(await f.runtime.service.paused(), false);
  assert.doesNotThrow(() => f.pool.emit('error', Error('PRIVATE_DB_URL')));
  assert.equal(f.runtime.status().observerStatus, 'UNAVAILABLE_OR_REVIEW_REQUIRED');
  assert.equal(await f.runtime.service.paused(), true);
  await assert.rejects(f.runtime.service.ready(), /STOCKS_PAUSED/);
  assert.equal((await app.inject('/ready/stocks')).statusCode, 503);
  assert.ok(!JSON.stringify(f.runtime.status()).includes('PRIVATE'));
  await f.runtime.tick();
  assert.equal((await app.inject('/ready/stocks')).statusCode, 200);
  assert.equal(await f.runtime.service.paused(), false);
});

test('an observation already in flight cannot erase a newer database failure', async t => {
  const f = await fixture(t); await f.runtime.tick();
  let started!: () => void, finish!: (value: 'CURRENT') => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.observe(() => { started(); return new Promise(resolve => { finish = resolve; }); });
  const pending = f.runtime.tick(); await entered;
  f.pool.emit('error', Error('PRIVATE_IDLE_FAILURE')); finish('CURRENT'); await pending;
  assert.equal(f.runtime.status().observerStatus, 'UNAVAILABLE_OR_REVIEW_REQUIRED');
  assert.equal(await f.runtime.service.paused(), true);
  f.observe(async () => 'CATCHING_UP'); await f.runtime.tick();
  assert.equal(await f.runtime.service.paused(), true);
  f.observe(async () => 'CURRENT'); await f.runtime.tick();
  assert.equal(await f.runtime.service.paused(), false);
});

test('database recovery never removes configured pause or resurrects a stopped runtime', async t => {
  const f = await fixture(t, true); await f.runtime.tick();
  f.pool.emit('error', Error('PRIVATE')); await f.runtime.tick();
  assert.equal(f.runtime.status().observerStatus, 'CURRENT'); assert.equal(await f.runtime.service.paused(), true);
  assert.deepEqual(f.runtime.status().pauseReasons, ['CONFIGURED_PAUSE']);
  await f.runtime.close(); assert.equal(f.ended(), 1);
  assert.doesNotThrow(() => f.pool.emit('error', Error('PRIVATE_AFTER_STOP')));
  await f.runtime.tick(); assert.equal(f.runtime.status().observerStatus, 'STOPPED');
  await f.runtime.close(); assert.equal(f.ended(), 1);
});

test('one pool listener survives startup and follows runtime replacement without retaining the retired runtime', () => {
  const pool = new EventEmitter(); let first = 0, second = 0;
  let runtime: { notifyDatabaseFailure(): void } | undefined;
  watchStocksPoolErrors(pool, () => runtime);
  assert.doesNotThrow(() => pool.emit('error', Error('PRIVATE_STARTUP')));
  runtime = { notifyDatabaseFailure() { first++; } }; pool.emit('error', Error('PRIVATE_FIRST'));
  runtime = { notifyDatabaseFailure() { second++; } }; pool.emit('error', Error('PRIVATE_SECOND'));
  assert.equal(first, 1); assert.equal(second, 1); assert.equal(pool.listenerCount('error'), 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeFunctionData, parseAbi } from 'viem';
import { createDeploymentEvidence } from './deployment.js';
import { h, testManifest } from '../stocks/test-fixtures.js';
import { manifestDigest, type Manifest } from '../stocks/contracts.js';
import type { JsonRpcTransport } from '../stocks/rpc.js';

const word = (v: bigint | string) => `0x${(typeof v === 'bigint' ? v.toString(16) : v.slice(2)).padStart(64, '0')}`;
function fixture() {
  const m = testManifest(), answers = new Map<string, string>();
  const bindings = [
    [m.stockToken, 'mintController', m.mintController], [m.stockToken, 'redemptionEscrow', m.redemptionEscrow],
    [m.fundingVault, 'cashToken', m.cashToken], [m.fundingVault, 'redemptionEscrow', m.redemptionEscrow], [m.fundingVault, 'operator', m.signerAddress],
    [m.mintController, 'stockToken', m.stockToken], [m.mintController, 'operator', m.signerAddress],
    [m.redemptionEscrow, 'stockToken', m.stockToken], [m.redemptionEscrow, 'cashToken', m.cashToken], [m.redemptionEscrow, 'fundingVault', m.fundingVault], [m.redemptionEscrow, 'operator', m.signerAddress],
  ];
  for (const [to, getter, value] of bindings) answers.set(`${to}:${encodeFunctionData({ abi: parseAbi([`function ${getter}() view returns (address)`]), functionName: getter })}`, word(value));
  for (const [to, decimals] of [[m.cashToken, 6n], [m.stockToken, 9n]] as const) answers.set(`${to}:${encodeFunctionData({ abi: parseAbi(['function decimals() view returns (uint8)']), functionName: 'decimals' })}`, word(decimals));
  const calls: string[] = [];
  const base: JsonRpcTransport = async (method, args) => {
    if (method === 'eth_chainId') return '0x164ce';
    if (method === 'eth_getBlockByNumber') {
      const number = args[0] === 'finalized' ? '0x64' : args[0] as string;
      return { number, hash: h(Number(BigInt(number))), timestamp: '0x3e8' };
    }
    if (method === 'eth_getCode') return '0x6000';
    if (method === 'eth_call') { const tx = args[0] as { to: string; data: string }; const v = answers.get(`${tx.to}:${tx.data}`); assert.ok(v); return v; }
    assert.fail(`Unexpected RPC ${method}`);
  };
  let wall = 1_000_000, mono = 0, live = true;
  let handler = base;
  const rpc: JsonRpcTransport = async (method, args) => { calls.push(method); return handler(method, args); };
  const opts = { now: () => wall, monotonicNow: () => mono, available: () => live };
  return { m, base, rpc, calls, opts, setHandler(fn: JsonRpcTransport) { handler = fn; }, advance(ms: number) { wall += ms; mono += ms; }, wall(v: number) { wall = v; }, mono(v: number) { mono = v; }, stop() { live = false; } };
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

test('deployment evidence verifies full contracts, coalesces reads, preserves lease and refreshes after expiry', async () => {
  const f = fixture(), gate = deferred<unknown>();
  f.setHandler(async (method, args) => { if (f.calls.length === 1) await gate.promise; return f.base(method, args); });
  const port = createDeploymentEvidence(f.m, f.rpc, f.opts);
  const first = port.get(), second = port.get(); await Promise.resolve(); assert.equal(f.calls.length, 1);
  f.advance(4000); gate.resolve(null);
  const [a, b] = await Promise.all([first, second]); assert.deepEqual(a, b);
  assert.equal(a.manifestDigest, manifestDigest(f.m)); assert.equal(a.verifiedAt, 1_000_000); assert.equal(a.validUntil, 1_015_000);
  assert.equal(f.calls.filter(m => m === 'eth_getCode').length, 5);
  assert.equal(f.calls.filter(m => m === 'eth_call').length, 13);
  const count = f.calls.length; f.advance(5000); assert.equal((await port.get()).evidenceId, a.evidenceId); assert.equal(f.calls.length, count);
  assert.ok(Object.isFrozen(a.manifest.codeHashes)); assert.throws(() => { (a.manifest as Manifest).deploymentId = 'mutated'; });
  f.advance(6000); const renewed = await port.get(); assert.notEqual(renewed.evidenceId, a.evidenceId); assert.equal(renewed.verifiedAt, 1_015_000);
});
for (const fault of ['chain', 'checkpoint', 'code', 'binding', 'decimals', 'finality', 'block-number', 'late-reorg', 'late-checkpoint', 'finality-regression']) {
  test(`deployment evidence rejects ${fault} and exposes no raw transport detail`, async () => {
    const f = fixture(); let blocks = 0, finalized = 0, checkpoints = 0;
    f.setHandler(async (method, args) => {
      const value = await f.base(method, args);
      if (fault === 'chain' && method === 'eth_chainId') return '0x1';
      if (method === 'eth_getBlockByNumber' && args[0] === '0x1') { checkpoints++; if (fault === 'checkpoint' || (fault === 'late-checkpoint' && checkpoints > 1)) return { ...(value as object), hash: h(99) }; }
      if (fault === 'code' && method === 'eth_getCode') return '0x6001';
      if (fault === 'binding' && method === 'eth_call') return word(999n);
      if (fault === 'decimals' && method === 'eth_call' && (args[0] as {data:string}).data === '0x313ce567') return word(18n);
      if (method === 'eth_getBlockByNumber' && args[0] === 'finalized') { finalized++; if (fault === 'finality') return null; if (fault === 'finality-regression' && finalized > 1) return { ...(value as object), number: '0x2' }; }
      if (method === 'eth_getBlockByNumber' && args[0] === '0x64') { blocks++; if (fault === 'late-reorg' && blocks >= 2) return { ...(value as object), hash: h(99) }; if (fault === 'block-number') return { ...(value as object), number: '0x65' }; }
      return value;
    });
    await assert.rejects(createDeploymentEvidence(f.m, f.rpc, f.opts).get(), /EXECUTION_DEPLOYMENT_UNVERIFIED/);
  });
}
test('stale evidence is never returned when refresh fails', async () => {
  const f = fixture(), port = createDeploymentEvidence(f.m, f.rpc, f.opts); await port.get(); f.advance(15000);
  f.setHandler(async () => { throw new Error('secret-http-token'); });
  await assert.rejects(port.get(), error => error instanceof Error && error.message === 'EXECUTION_DEPLOYMENT_UNVERIFIED');
});
test('wall and monotonic reversals deny cached evidence; monotonic expiry cannot be extended by a slow wall clock', async () => {
  for (const kind of ['wall', 'mono', 'slow-wall']) {
    const f = fixture(), port = createDeploymentEvidence(f.m, f.rpc, f.opts); await port.get(); f.advance(1); await port.get();
    if (kind === 'wall') f.wall(999999); else if (kind === 'mono') f.mono(-1); else f.mono(16000);
    if (kind !== 'slow-wall') await assert.rejects(port.get(), /EXECUTION_CLOCK_INVALID/);
    else { const before = f.calls.length; await port.get(); assert.ok(f.calls.length > before); }
  }
});
test('timeout prevents late cache publication and even the internal network checkpoint read', async () => {
  const f = fixture(), gate = deferred<unknown>(); f.setHandler(async () => gate.promise);
  const port = createDeploymentEvidence(f.m, f.rpc, { ...f.opts, timeoutMs: 10 });
  await assert.rejects(port.get(), /EXECUTION_VERIFICATION_TIMEOUT/);
  gate.resolve('0x164ce'); await new Promise(r => setTimeout(r, 20)); assert.equal(f.calls.length, 1);
  f.setHandler(f.base); await port.get(); assert.equal(f.calls.filter(m => m === 'eth_chainId').length, 3);
});
test('synchronous stall is checked even before timer fires', async () => {
  const f = fixture(); f.setHandler(async (method, args) => { f.advance(8000); return f.base(method, args); });
  await assert.rejects(createDeploymentEvidence(f.m, f.rpc, f.opts).get(), /EXECUTION_VERIFICATION_TIMEOUT/); assert.equal(f.calls.length, 1);
});
test('runtime stop denies cached and pending evidence with no subsequent RPC', async () => {
  const f = fixture(), port = createDeploymentEvidence(f.m, f.rpc, f.opts); await port.get(); const count = f.calls.length; f.stop();
  await assert.rejects(port.get(), /EXECUTION_UNAVAILABLE/); assert.equal(f.calls.length, count);
  const g = fixture(), gate = deferred<unknown>(); g.setHandler(async () => gate.promise);
  const pending = createDeploymentEvidence(g.m, g.rpc, g.opts).get(); await Promise.resolve(); g.stop(); gate.resolve('0x164ce');
  await assert.rejects(pending, /EXECUTION_UNAVAILABLE/); assert.equal(g.calls.length, 1);
});
test('manifest extension/config secrets are rejected before RPC; whitelist output is unchanged and snapshotted', async () => {
  const f = fixture();
  assert.throws(() => createDeploymentEvidence({ ...f.m, signerToken: 'NOT_PUBLIC' } as Manifest, f.rpc), /EXECUTION_MANIFEST_NOT_PUBLIC/);
  assert.throws(() => createDeploymentEvidence({ ...f.m, codeHashes: { ...f.m.codeHashes, privateConfig: 'NOT_PUBLIC' } } as unknown as Manifest, f.rpc), /EXECUTION_MANIFEST_NOT_PUBLIC/);
  assert.equal(f.calls.length, 0); const port = createDeploymentEvidence(f.m, f.rpc, f.opts); const digest = manifestDigest(f.m); f.m.deploymentId = 'MUTATED_TEST_CONFIG';
  assert.equal((await port.get()).manifestDigest, digest);
});

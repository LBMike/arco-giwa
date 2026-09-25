import test from 'node:test';
import assert from 'node:assert/strict';
import { createTusdcSigningSession } from './tusdc-signing-session.mjs';

const SIGNER = `0x${'a'.repeat(40)}`;
const SIGNED = '0x02aabb'; // A fake result; cryptographic attestation belongs to the executor.
const limits = () => ({ maxGas: '5000000', maxPriorityFeePerGas: '1000000', maxFeePerGas: '10000000', maxTotalFeeWei: '50000000000000' });
const plans = () => Array.from({ length: 4 }, (_, i) => ({ chainId: 91342, from: SIGNER, nonce: `0x${(232 + i).toString(16)}`, to: null, value: '0x0', data: `0x600${i}` }));
const transaction = (index = 0) => ({ type: 2, chainId: 91342, nonce: plans()[index].nonce, value: '0', data: plans()[index].data,
  gasLimit: '1000000', maxPriorityFeePerGas: '1000000', maxFeePerGas: '10000000', accessList: [] });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides = {}) {
  let unlocks = 0;
  const calls = [];
  const wallet = { address: SIGNER, async signTransaction(tx) { calls.push(tx); return SIGNED; } };
  const session = createTusdcSigningSession({ transactions: plans(), expectedSigner: SIGNER, limits: limits(),
    unlock: async () => { unlocks++; return wallet; }, ...overrides });
  return { session, calls, wallet, unlocks: () => unlocks };
}
test('four reviewed CREATEs unlock once and automatically close after the final signature', async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) assert.equal(await f.session.sign(transaction(i)), SIGNED);
  assert.equal(f.unlocks(), 1); assert.equal(f.calls.length, 4);
  assert.ok(f.calls.every(tx => Object.isFrozen(tx) && Object.isFrozen(tx.accessList)));
  await assert.rejects(f.session.sign(transaction(3)), /^Error: TUSDC_SIGNING_SESSION_CLOSED$/);
  f.session.close(); f.session.close();
});
test('partial resume can begin at nonce233, then only consecutive remaining nonces are accepted', async () => {
  const f = fixture();
  for (const i of [1, 2, 3]) await f.session.sign(transaction(i));
  assert.equal(f.unlocks(), 1); assert.deepEqual(f.calls.map(tx => tx.nonce), ['0xe9', '0xea', '0xeb']);
});
test('duplicate, skipped and out-of-range requests cannot unlock or sign again', async () => {
  for (const second of [transaction(0), transaction(2), { ...transaction(), nonce: '0xec' }]) {
    const f = fixture(); await f.session.sign(transaction());
    await assert.rejects(f.session.sign(second), /TUSDC_SIGNING_SESSION_REQUEST_DENIED/);
    await assert.rejects(f.session.sign(transaction(1)), /TUSDC_SIGNING_SESSION_CLOSED/);
    assert.equal(f.unlocks(), 1); assert.equal(f.calls.length, 1);
  }
});
test('unexpected fields, nonce, chain, CREATE shape, calldata, access list and fee bounds fail before unlock', async () => {
  const accessor = transaction(); Object.defineProperty(accessor, 'data', { get: () => '0x6000' });
  const extraAccess = []; extraAccess.ignored = true;
  for (const input of [accessor, { ...transaction(), privateKey: 'DO_NOT_LOG_INPUT' }, { ...transaction(), type: 0 },
    { ...transaction(), chainId: 1 }, { ...transaction(), nonce: '0x0e8' }, { ...transaction(), nonce: '0xe7' },
    { ...transaction(), to: SIGNER }, { ...transaction(), from: SIGNER }, { ...transaction(), value: '1' },
    { ...transaction(), data: '0x600f' }, { ...transaction(), accessList: [{}] }, { ...transaction(), accessList: extraAccess },
    { ...transaction(), gasLimit: '5000001' }, { ...transaction(), gasLimit: '0' }, { ...transaction(), gasLimit: 1000000 },
    { ...transaction(), maxFeePerGas: '10000001' }, { ...transaction(), maxPriorityFeePerGas: '1000001' },
    { ...transaction(), maxFeePerGas: '1' }, { ...transaction(), gasLimit: '01000000' }]) {
    const f = fixture();
    await assert.rejects(f.session.sign(input), /^Error: TUSDC_SIGNING_SESSION_REQUEST_DENIED$/);
    assert.equal(f.unlocks(), 0); assert.equal(f.calls.length, 0);
  }
  const f = fixture({ limits: { ...limits(), maxTotalFeeWei: '9999999999999' } });
  await assert.rejects(f.session.sign(transaction()), /REQUEST_DENIED/); assert.equal(f.unlocks(), 0);
});
test('the full immutable four-step allowlist and approved fee limits are required at construction', () => {
  for (const patch of [{ transactions: plans().slice(1) }, { transactions: [...plans()].reverse() },
    { expectedSigner: `0x${'b'.repeat(40)}` }, { expectedSigner: `0x${'0'.repeat(40)}` },
    { transactions: plans().map(tx => ({ ...tx, from: `0x${'b'.repeat(40)}` })) },
    { transactions: plans().map(tx => ({ ...tx, ignored: true })) }, { limits: undefined },
    { limits: { ...limits(), maxGas: '0' } }, { limits: { ...limits(), privateKey: 'DO_NOT_LOG_INPUT' } },
    { ttlMs: 600001 }, { ttlMs: 0 }, { ttlMs: NaN }, { unlock: null }, { signal: {} }]) {
    assert.throws(() => fixture(patch), /^Error: TUSDC_SIGNING_SESSION_CONFIGURATION_INVALID$/);
  }
});
test('caller mutation during unlock cannot alter the captured transaction, plan or limits', async () => {
  const opening = deferred(), captured = [], plan = plans(), cap = limits();
  const f = fixture({ transactions: plan, limits: cap, unlock: () => opening.promise });
  const input = transaction(); const signing = f.session.sign(input);
  input.data = '0xdead'; input.nonce = '0xeb'; input.gasLimit = '999999999'; input.accessList.push({});
  plan[0].data = '0xdead'; cap.maxGas = '1';
  opening.resolve({ async signTransaction(tx) { captured.push(tx); return SIGNED; } });
  assert.equal(await signing, SIGNED);
  assert.equal(captured[0].nonce, '0xe8'); assert.equal(captured[0].data, '0x6000');
  assert.equal(captured[0].gasLimit, '1000000'); assert.deepEqual(captured[0].accessList, []);
  f.session.close();
});
test('concurrent request during unlock retires the session and discards the first result', async () => {
  const opening = deferred(); let signed = 0, opened = 0;
  const f = fixture({ unlock: () => { opened++; return opening.promise; } });
  const first = f.session.sign(transaction());
  await assert.rejects(f.session.sign(transaction(1)), /TUSDC_SIGNING_SESSION_BUSY/);
  opening.resolve({ async signTransaction() { signed++; return SIGNED; } });
  await assert.rejects(first, /TUSDC_SIGNING_SESSION_CLOSED/);
  assert.equal(opened, 1); assert.equal(signed, 0);
});
test('concurrent request during signing discards the pending signature without retrying', async () => {
  const signed = deferred(), arrived = deferred(); let calls = 0;
  const f = fixture({ unlock: async () => ({ signTransaction: () => { calls++; arrived.resolve(); return signed.promise; } }) });
  const first = f.session.sign(transaction()); await arrived.promise;
  await assert.rejects(f.session.sign(transaction(1)), /TUSDC_SIGNING_SESSION_BUSY/);
  signed.resolve(SIGNED); await assert.rejects(first, /TUSDC_SIGNING_SESSION_CLOSED/);
  assert.equal(calls, 1);
});
test('expiry starts at unlock, applies across awaits, and cannot automatically reopen custody', async () => {
  let now = 0; const opening = deferred(); let opens = 0;
  const f = fixture({ now: () => now, ttlMs: 100, unlock: () => { opens++; return opening.promise; } });
  now = 10000; // Time before the first request does not consume the unlocked lifetime.
  const first = f.session.sign(transaction()); now = 10100;
  opening.resolve({ async signTransaction() { assert.fail('expired unlock must not sign'); } });
  await assert.rejects(first, /TUSDC_SIGNING_SESSION_EXPIRED/);
  await assert.rejects(f.session.sign(transaction()), /TUSDC_SIGNING_SESSION_EXPIRED/);
  assert.equal(opens, 1);
});
test('clock rollback or expiry after a signature disables later requests', async () => {
  for (const next of [9, 110]) {
    let now = 10; const f = fixture({ now: () => now, ttlMs: 100 });
    await f.session.sign(transaction()); now = next;
    await assert.rejects(f.session.sign(transaction(1)), /TUSDC_SIGNING_SESSION_(CLOSED|EXPIRED)/);
    assert.equal(f.unlocks(), 1); assert.equal(f.calls.length, 1);
  }
});
test('real timer closes an idle unlocked session without another signing request', async () => {
  const f = fixture({ ttlMs: 20 }); await f.session.sign(transaction());
  await new Promise(resolve => setTimeout(resolve, 40));
  await assert.rejects(f.session.sign(transaction(1)), /TUSDC_SIGNING_SESSION_EXPIRED/);
  assert.equal(f.unlocks(), 1);
});
test('close and abort before/during unlock discard capability without signing', async () => {
  for (const action of ['close', 'abort']) {
    const abort = new AbortController(), opening = deferred(); let signs = 0;
    const f = fixture({ signal: abort.signal, unlock: () => opening.promise });
    const first = f.session.sign(transaction());
    action === 'close' ? f.session.close() : abort.abort();
    opening.resolve({ async signTransaction() { signs++; return SIGNED; } });
    await assert.rejects(first, /TUSDC_SIGNING_SESSION_(CLOSED|ABORTED)/);
    await assert.rejects(f.session.sign(transaction()), /TUSDC_SIGNING_SESSION_(CLOSED|ABORTED)/);
    assert.equal(signs, 0);
  }
  const abort = new AbortController(); abort.abort(); const f = fixture({ signal: abort.signal });
  await assert.rejects(f.session.sign(transaction()), /ABORTED/); assert.equal(f.unlocks(), 0);
  const closed = fixture(); closed.session.close();
  await assert.rejects(closed.session.sign(transaction()), /CLOSED/); assert.equal(closed.unlocks(), 0);
});
test('close, abort and TTL expiry while an async signer runs discard the returned signature', async () => {
  for (const action of ['close', 'abort', 'expire']) {
    const abort = new AbortController(), done = deferred(), arrived = deferred(); let now = 0;
    const f = fixture({ signal: abort.signal, now: () => now, ttlMs: 100,
      unlock: async () => ({ signTransaction() { arrived.resolve(); return done.promise; } }) });
    const first = f.session.sign(transaction()); await arrived.promise;
    if (action === 'close') f.session.close(); else if (action === 'abort') abort.abort(); else now = 100;
    done.resolve(SIGNED);
    await assert.rejects(first, /TUSDC_SIGNING_SESSION_(CLOSED|ABORTED|EXPIRED)/);
  }
});
test('wrong optional wallet address and unlock/sign errors fail closed without leaking input or re-unlocking', async () => {
  for (const unlock of [async () => { throw Error('DO_NOT_LOG_PASSWORD'); },
    async () => ({ address: `0x${'b'.repeat(40)}`, async signTransaction() { assert.fail('wrong wallet'); } }),
    async () => ({ async signTransaction() { throw Error('DO_NOT_LOG_PRIVATE_VALUE'); } }),
    async () => ({ async signTransaction() { return 'DO_NOT_LOG_RAW_VALUE'; } })]) {
    let opens = 0; const f = fixture({ unlock: async () => { opens++; return unlock(); } });
    await assert.rejects(f.session.sign(transaction()), /^Error: TUSDC_SIGNING_SESSION_(UNLOCK_FAILED|SIGN_FAILED)$/);
    await assert.rejects(f.session.sign(transaction()), /^Error: TUSDC_SIGNING_SESSION_CLOSED$/);
    assert.equal(opens, 1);
  }
});

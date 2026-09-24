import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseTransaction } from 'viem';
import { createLocalKeystoreCustody, type LocalWalletSigner } from './custody-local.js';
import type { OriginalSignRequest } from './original-transport.js';
const fees = { gas: 100_000n, maxFeePerGas: 1000n, maxPriorityFeePerGas: 10n };
const limits = { maxGas: 200_000n, maxFeePerGas: 2000n, maxTotalFeeWei: 400_000_000n };
const request = (): OriginalSignRequest => ({ chainId: 91342, nonce: 231n,
  to: '0x1111111111111111111111111111111111111111', data: '0x12345678', value: 0n });
function fixture() {
  const account = privateKeyToAccount(generatePrivateKey());
  const sign: LocalWalletSigner = tx => account.signTransaction({ type: 'eip1559', chainId: tx.chainId,
    nonce: Number(BigInt(tx.nonce)), to: tx.to as `0x${string}`, data: tx.data as `0x${string}`,
    value: BigInt(tx.value), gas: BigInt(tx.gasLimit), maxFeePerGas: BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) });
  return { account, sign };
}
test('local custody signs the exact bounded transaction and closing revokes signing', async () => {
  const { account, sign } = fixture(); let calls = 0;
  const custody = createLocalKeystoreCustody({ signerAddress: account.address, fees, limits,
    signTransaction: async tx => { calls++; assert.equal(Object.isFrozen(tx), true); return sign(tx); } });
  assert.equal(await custody.ready(), true);
  const raw = await custody.signOriginal(request());
  const tx = parseTransaction(raw);
  assert.equal(tx.nonce, 231); assert.equal(tx.chainId, 91342); assert.equal(tx.gas, fees.gas);
  assert.equal(tx.to, request().to); assert.equal(tx.data, request().data); assert.equal(tx.value ?? 0n, 0n);
  custody.close(); custody.close();
  assert.equal(await custody.ready(), false);
  await assert.rejects(custody.signOriginal(request()), /^Error: SIGNER_LOCAL_CUSTODY_UNAVAILABLE$/);
  assert.equal(calls, 1);
});
test('malformed scope never reaches the signing capability', async () => {
  const { account } = fixture(); let calls = 0;
  const custody = createLocalKeystoreCustody({ signerAddress: account.address, fees, limits,
    signTransaction: async () => { calls++; throw Error('MUST_NOT_SIGN'); } });
  for (const patch of [{ chainId: 1 }, { value: 1n }, { nonce: -1n }, { nonce: 2n ** 53n },
    { nonce: '231' }, { to: '0x0000000000000000000000000000000000000000' },
    { data: '0x1' }, { data: '0x' + 'ff'.repeat(8000) }, { privateKey: 'NO_SECRET_INPUT' }])
    await assert.rejects(custody.signOriginal({ ...request(), ...patch } as OriginalSignRequest), /^Error: SIGNER_LOCAL_CUSTODY_UNAVAILABLE$/);
  assert.equal(calls, 0);
});
test('wrong signer, modified transaction and capability errors never expose signed bytes or error content', async () => {
  const { account, sign } = fixture(), other = fixture();
  for (const callback of [other.sign, async (tx: Parameters<LocalWalletSigner>[0]) => sign({ ...tx, value: '0x1' }),
    async () => { throw Error('DO_NOT_PRINT_CUSTODY_DETAILS'); }, async () => 'not-signed-bytes']) {
    const custody = createLocalKeystoreCustody({ signerAddress: account.address, fees, limits, signTransaction: callback });
    await assert.rejects(custody.signOriginal(request()), /^Error: SIGNER_LOCAL_CUSTODY_UNAVAILABLE$/);
    custody.close();
  }
});
test('request and fee inputs cannot change an admitted signature, and late results after close are rejected', async () => {
  const { account, sign } = fixture(); const mutableFees = { ...fees };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const custody = createLocalKeystoreCustody({ signerAddress: account.address, fees: mutableFees, limits,
    signTransaction: async tx => { await held; return sign(tx); } });
  const input = { ...request() };
  const pending = custody.signOriginal(input);
  input.nonce = 232n; mutableFees.gas = 9_000_000n; release();
  const tx = parseTransaction(await pending); assert.equal(tx.nonce, 231); assert.equal(tx.gas, fees.gas);
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const closing = createLocalKeystoreCustody({ signerAddress: account.address, fees, limits,
    signTransaction: async tx => { await blocked; return sign(tx); } });
  const late = assert.rejects(closing.signOriginal(request()), /^Error: SIGNER_LOCAL_CUSTODY_UNAVAILABLE$/);
  closing.close(); finish(); await late;
});
test('fee policy is validated before a signing capability can be used', () => {
  const { account, sign } = fixture();
  for (const patch of [{ gas: 0n }, { gas: limits.maxGas + 1n }, { maxPriorityFeePerGas: fees.maxFeePerGas + 1n },
    { maxFeePerGas: limits.maxFeePerGas + 1n }])
    assert.throws(() => createLocalKeystoreCustody({ signerAddress: account.address, fees: { ...fees, ...patch }, limits, signTransaction: sign }));
});

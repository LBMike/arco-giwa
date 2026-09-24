import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizedCall } from '../stocks/chain.js';
import { callDigest, manifestDigest, StocksError } from '../stocks/contracts.js';
import { a, h, testManifest } from '../stocks/test-fixtures.js';
import type { SignerOperation } from './core.js';
import { verifyOriginalTransaction } from './original-transaction.js';

const manifest = testManifest();
const call = authorizedCall(manifest, 'mint:original-lookup', 'MINT', a(10), '12');
const operation: SignerOperation = {
  operationId: call.operationId, deploymentDigest: manifestDigest(manifest), callDigest: callDigest(call),
  call, originalNonce: '7', txHash: null,
};
const transaction = {
  hash: h(55), chainId: '0x164ce', from: manifest.signerAddress, nonce: '0x7',
  to: call.to, input: call.data, value: '0x0', blockHash: h(54),
};
const isMismatch = (error: unknown) => error instanceof StocksError
  && error.code === 'SIGNER_ORIGINAL_TRANSACTION_MISMATCH' && error.status === 503;

test('accepts only the hash of the exact original signer transaction', () => {
  assert.equal(verifyOriginalTransaction(operation, manifest.signerAddress, transaction), h(55));
  assert.equal(verifyOriginalTransaction(operation, manifest.signerAddress,
    { ...transaction, from: `0x${manifest.signerAddress.slice(2).toUpperCase()}` }), h(55));
});

test('absence is unknown, never proof that the original nonce can be sent again', () => {
  assert.equal(verifyOriginalTransaction(operation, manifest.signerAddress, null), null);
  assert.throws(() => verifyOriginalTransaction(operation, manifest.signerAddress, undefined), isMismatch);
});

test('rejects another transaction at the reserved nonce and malformed RPC data', () => {
  const other = authorizedCall(manifest, call.operationId, 'MINT', a(10), '13');
  for (const candidate of [
    { ...transaction, chainId: '0x1' },
    { ...transaction, chainId: undefined },
    { ...transaction, from: a(11) },
    { ...transaction, nonce: '0x8' },
    { ...transaction, nonce: '0x07' },
    { ...transaction, to: a(11) },
    { ...transaction, to: null },
    { ...transaction, input: other.data },
    { ...transaction, value: '0x1' },
    { ...transaction, hash: h(0) },
    { ...transaction, hash: 'PRIVATE_PROVIDER_RESPONSE' },
    [],
  ]) assert.throws(() => verifyOriginalTransaction(operation, manifest.signerAddress, candidate), isMismatch);
});

test('rejects a stored operation that is outside the signer or nonce scope before trusting absence', () => {
  for (const changed of [
    { ...operation, call: { ...operation.call, chainId: 1 } },
    { ...operation, call: { ...operation.call, from: a(11) } },
    { ...operation, call: { ...operation.call, value: '1' } },
    { ...operation, callDigest: '0'.repeat(64) },
    { ...operation, originalNonce: '-1' },
    { ...operation, originalNonce: (2n ** 256n).toString() },
  ]) assert.throws(() => verifyOriginalTransaction(changed as SignerOperation, manifest.signerAddress, null), isMismatch);
  assert.throws(() => verifyOriginalTransaction(operation, a(11), null), isMismatch);
});

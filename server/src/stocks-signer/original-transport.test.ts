import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { authorizedCall } from '../stocks/chain.js';
import { callDigest, manifestDigest, StocksError } from '../stocks/contracts.js';
import type { JsonRpcTransport } from '../stocks/rpc.js';
import { a, h, testManifest } from '../stocks/test-fixtures.js';
import { createStocksSignerCore, type DurableSignerJournal, type SignerOperation } from './core.js';
import { createOriginalSignerTransport, verifySignedOriginal, type OriginalSignRequest,
  type SignedTransactionLimits } from './original-transport.js';

// Disposable deterministic test account, never selected by runtime composition.
const signer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945384dbb2c0f25b563eab2bfb184c3f8816d1');
const other = privateKeyToAccount('0x8b3a350cf5c34c9194ca4ca3a9d8b0648b4e20f87e0aa76993c9c15b1e8ba252');
const manifest = { ...testManifest(), signerAddress: signer.address };
const call = authorizedCall(manifest, 'mint:original-transport', 'MINT', a(10), '12');
const operation: SignerOperation = {
  operationId: call.operationId, deploymentDigest: manifestDigest(manifest), callDigest: callDigest(call),
  call, originalNonce: '7', txHash: null,
};
const request: OriginalSignRequest = { chainId: 91342, nonce: 7n, to: call.to,
  data: call.data as Hex, value: 0n };
const limits: SignedTransactionLimits = {
  maxGas: 200_000n, maxFeePerGas: 30_000_000_000n, maxTotalFeeWei: 3_000_000_000_000_000n,
};
const transaction = {
  type: 'eip1559' as const, chainId: 91342, nonce: 7, to: call.to,
  data: call.data as Hex, value: 0n, gas: 100_000n,
  maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
};
const sign = (overrides: Record<string, unknown> = {}, account = signer) =>
  account.signTransaction({ ...transaction, ...overrides } as Parameters<typeof account.signTransaction>[0]);
const isCode = (code: string) => (error: unknown) => error instanceof StocksError && error.code === code && error.status === 503;

function fixture(options: { rpcHash?: string; checkpointHash?: string; candidate?: unknown; initialSignedHash?: string } = {}) {
  let sends = 0, signings = 0, lookups = 0;
  let signedHash: string | null = options.initialSignedHash ?? null;
  const methods: string[] = [];
  const rpc: JsonRpcTransport = async (method, params) => {
    methods.push(method);
    if (method === 'eth_chainId') return '0x164ce';
    if (method === 'eth_getBlockByNumber') {
      assert.deepEqual(params, ['0x1', false]);
      return { hash: options.checkpointHash ?? manifest.checkpointHash };
    }
    if (method === 'eth_sendRawTransaction') {
      sends++;
      return options.rpcHash ?? keccak256(params[0] as Hex);
    }
    throw Error('UNEXPECTED_RPC_METHOD');
  };
  const transport = createOriginalSignerTransport({ manifest, rpc,
    custody: { async signOriginal(input) {
      signings++;
      assert.deepEqual(input, request);
      return sign();
    } },
    intent: { async recordSignedHash(_operation, txHash) {
      assert.equal(signedHash, null);
      signedHash = txHash;
      return txHash;
    }, async readSignedHash() { return signedHash; } },
    lookup: { async findAtOriginalNonce(input) {
      lookups++;
      assert.deepEqual(input, operation);
      return options.candidate ?? null;
    } }, limits });
  return { transport, methods, get sends() { return sends; }, get signings() { return signings; },
    get lookups() { return lookups; }, get signedHash() { return signedHash; } };
}

test('sends one exact signed EIP-1559 transaction and checks the returned hash', async () => {
  const raw = await sign();
  assert.deepEqual(await verifySignedOriginal(request, signer.address, raw, limits), { raw, txHash: keccak256(raw) });
  const f = fixture();
  assert.equal(await f.transport.sendOnce(operation), keccak256(raw));
  assert.equal(f.signings, 1);
  assert.equal(f.sends, 1);
  assert.equal(f.signedHash, keccak256(raw));
  assert.deepEqual(f.methods, ['eth_chainId', 'eth_getBlockByNumber', 'eth_sendRawTransaction']);
});

test('refuses wrong signer, chain, nonce, target, calldata and nonzero value before broadcast', async () => {
  const invalidSigned = [
    await sign({}, other),
    await sign({ chainId: 1 }),
    await sign({ nonce: 8 }),
    await sign({ to: a(11) }),
    await sign({ data: '0x12345678' }),
    await sign({ value: 1n }),
    await signer.signTransaction({ type: 'legacy', chainId: 91342, nonce: 7, to: call.to,
      data: call.data as Hex, value: 0n, gas: 100_000n, gasPrice: 20_000_000_000n }),
  ];
  for (const raw of invalidSigned)
    await assert.rejects(verifySignedOriginal(request, signer.address, raw, limits), isCode('SIGNER_SIGNED_TRANSACTION_MISMATCH'));
  let sends = 0;
  for (const raw of invalidSigned) {
    const transport = createOriginalSignerTransport({ manifest, limits,
      rpc: async method => method === 'eth_chainId' ? '0x164ce'
        : method === 'eth_getBlockByNumber' ? { hash: manifest.checkpointHash }
          : (sends++, keccak256(raw)),
      custody: { signOriginal: async () => raw },
      intent: { recordSignedHash: async () => { throw Error('UNEXPECTED_INTENT'); }, readSignedHash: async () => null },
      lookup: { findAtOriginalNonce: async () => null } });
    await assert.rejects(transport.sendOnce(operation), isCode('SIGNER_ORIGINAL_OUTCOME_UNKNOWN'));
  }
  assert.equal(sends, 0);
});

test('enforces gas, per-gas and total fee caps on signed bytes', async () => {
  for (const raw of [
    await sign({ gas: 200_001n }),
    await sign({ maxFeePerGas: 30_000_000_001n }),
    await sign({ gas: 200_000n, maxFeePerGas: 20_000_000_000n }),
    await sign({ accessList: [{ address: a(11), storageKeys: [] }] }),
  ]) await assert.rejects(verifySignedOriginal(request, signer.address, raw, limits), isCode('SIGNER_SIGNED_TRANSACTION_MISMATCH'));
  await assert.rejects(verifySignedOriginal(request, signer.address, await sign(),
    { ...limits, maxGas: 0n }), isCode('SIGNER_SIGNED_TRANSACTION_MISMATCH'));
});

test('rejects wrong RPC send hash and wrong network checkpoint without another send', async () => {
  const wrongHash = fixture({ rpcHash: h(99) });
  await assert.rejects(wrongHash.transport.sendOnce(operation), isCode('SIGNER_ORIGINAL_OUTCOME_UNKNOWN'));
  assert.equal(wrongHash.sends, 1);
  const wrongCheckpoint = fixture({ checkpointHash: h(99) });
  await assert.rejects(wrongCheckpoint.transport.sendOnce(operation), isCode('SIGNER_NETWORK_UNAVAILABLE'));
  assert.equal(wrongCheckpoint.signings, 0);
  assert.equal(wrongCheckpoint.sends, 0);
  assert.equal(wrongCheckpoint.lookups, 0);
});

test('never broadcasts when the signed intent is not durably acknowledged', async () => {
  let sends = 0;
  const transport = createOriginalSignerTransport({ manifest, limits,
    rpc: async method => {
      if (method === 'eth_chainId') return '0x164ce';
      if (method === 'eth_getBlockByNumber') return { hash: manifest.checkpointHash };
      sends++;
      return h(99);
    },
    custody: { signOriginal: async () => sign() },
    intent: { recordSignedHash: async () => { throw Error('TEST_ONLY_LOST_DATABASE_ACK'); },
      readSignedHash: async () => null },
    lookup: { findAtOriginalNonce: async () => null } });
  await assert.rejects(transport.sendOnce(operation), isCode('SIGNER_ORIGINAL_OUTCOME_UNKNOWN'));
  assert.equal(sends, 0);
});

test('lookup returns only the transaction at the original signer and nonce', async () => {
  const original = { hash: h(70), chainId: '0x164ce', from: signer.address,
    nonce: '0x7', to: call.to, input: call.data, value: '0x0' };
  const found = fixture({ candidate: original, initialSignedHash: original.hash });
  assert.equal(await found.transport.findOriginal(operation), original.hash);
  assert.equal(found.sends, 0);
  assert.equal(found.lookups, 1);
  const missing = fixture();
  assert.equal(await missing.transport.findOriginal(operation), null);
  const foreign = fixture({ candidate: { ...original, nonce: '0x8' }, initialSignedHash: original.hash });
  await assert.rejects(foreign.transport.findOriginal(operation), isCode('SIGNER_ORIGINAL_TRANSACTION_MISMATCH'));
  assert.equal(foreign.sends, 0);
  const reset = fixture({ candidate: original, initialSignedHash: original.hash, checkpointHash: h(99) });
  await assert.rejects(reset.transport.findOriginal(operation), isCode('SIGNER_NETWORK_UNAVAILABLE'));
  assert.equal(reset.lookups, 0);
  const replaced = fixture({ candidate: { ...original, hash: h(71) }, initialSignedHash: original.hash });
  await assert.rejects(replaced.transport.findOriginal(operation), isCode('SIGNER_ORIGINAL_TRANSACTION_MISMATCH'));
  const uncommitted = fixture({ candidate: original });
  assert.equal(await uncommitted.transport.findOriginal(operation), null);
  assert.equal(uncommitted.lookups, 0);
});

test('lost acknowledgement remains unknown; replay uses the journal and lookup, never a second send', async () => {
  // Use a candidate found from the one accepted broadcast after its response is lost.
  let stored: SignerOperation | null = null;
  let candidate: unknown = null;
  const rpc: JsonRpcTransport = async (method, params) => {
    if (method === 'eth_chainId') return '0x164ce';
    if (method === 'eth_getBlockByNumber') return { hash: manifest.checkpointHash };
    if (method === 'eth_sendRawTransaction') {
      const raw = params[0] as Hex;
      candidate = { hash: keccak256(raw), chainId: '0x164ce', from: signer.address,
        nonce: '0x7', to: call.to, input: call.data, value: '0x0' };
      throw Error('PRIVATE_PROVIDER_RESPONSE');
    }
    throw Error('UNEXPECTED_RPC_METHOD');
  };
  let sends = 0;
  let signedHash: string | null = null;
  const transport = createOriginalSignerTransport({ manifest, limits,
    rpc: async (method, params) => { if (method === 'eth_sendRawTransaction') sends++; return rpc(method, params); },
    custody: { signOriginal: async () => sign() },
    intent: { async recordSignedHash(_operation, txHash) { signedHash = txHash; return txHash; },
      async readSignedHash() { return signedHash; } },
    lookup: { findAtOriginalNonce: async () => candidate } });
  const journal: DurableSignerJournal = {
    async reserve(input) {
      if (stored) return { created: false, operation: stored };
      stored = { ...input, originalNonce: '7', txHash: null };
      return { created: true, operation: stored };
    },
    async read() { return stored; },
    async recordHash(id, digest, txHash) {
      assert.ok(stored);
      assert.equal(id, stored.operationId);
      assert.equal(digest, stored.callDigest);
      stored = { ...stored, txHash };
      return stored;
    },
  };
  const core = createStocksSignerCore({ manifest, journal, transport });
  const body = { protocol: 'ARCO_STOCKS_SIGNER_V1', deploymentDigest: manifestDigest(manifest), call, callDigest: callDigest(call) };
  await assert.rejects(core.submit(call.operationId, body), isCode('SIGNER_ORIGINAL_OUTCOME_UNKNOWN'));
  assert.equal(sends, 1);
  assert.equal(await core.submit(call.operationId, body), null);
  assert.equal(sends, 1);
  assert.equal((await core.lookup(call.operationId))?.txHash, (candidate as { hash: string }).hash);
  assert.equal(sends, 1);
  assert.equal((await core.submit(call.operationId, body))?.txHash, (candidate as { hash: string }).hash);
  assert.equal(sends, 1);
});

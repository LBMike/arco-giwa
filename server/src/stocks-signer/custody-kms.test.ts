import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { KMSClient, GetPublicKeyCommand, SignCommand } from '@aws-sdk/client-kms';
import { bytesToHex, hexToBytes, parseTransaction, recoverTransactionAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts';
import { a } from '../stocks/test-fixtures.js';
import { awsKmsSigningPort, createKmsCustody, type KmsSigningPort } from './custody-kms.js';
import type { OriginalSignRequest } from './original-transport.js';
const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const keyArn = 'arn:aws:kms:ap-northeast-2:123456789012:key/12345678-1234-1234-1234-123456789012';
const fees = { gas: 1_000_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
const limits = { maxGas: 2_000_000n, maxFeePerGas: 3_000_000_000n, maxTotalFeeWei: 6_000_000_000_000_000n };
const request: OriginalSignRequest = { chainId: 91342, nonce: 7n, to: a(101), data: '0x1234', value: 0n };
function der(r: bigint, s: bigint): Uint8Array {
  const integer = (n: bigint) => {
    let h = n.toString(16); if (h.length % 2) h = '0' + h;
    let b = Buffer.from(h, 'hex'); if (b[0] >= 128) b = Buffer.concat([Buffer.from([0]), b]);
    return Buffer.concat([Buffer.from([2, b.length]), b]);
  };
  const body = Buffer.concat([integer(r), integer(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}
function fixture() {
  // Ephemeral test-only key, generated in memory; never persisted or logged.
  const privateKey = generatePrivateKey(), account = privateKeyToAccount(privateKey);
  const pub = hexToBytes(account.publicKey);
  const spki = createPublicKey({ key: { kty: 'EC', crv: 'secp256k1',
    x: Buffer.from(pub.slice(1, 33)).toString('base64url'), y: Buffer.from(pub.slice(33)).toString('base64url') },
    format: 'jwk' }).export({ format: 'der', type: 'spki' });
  const state = { reads: 0, signs: 0, destroys: 0, high: false, hang: false, reject: false,
    keyPatch: {} as Record<string, unknown>, signPatch: {} as Record<string, unknown>, signal: undefined as AbortSignal | undefined };
  const port: KmsSigningPort = {
    async getPublicKey() {
      state.reads++;
      return { KeyId: keyArn, KeySpec: 'ECC_SECG_P256K1', KeyUsage: 'SIGN_VERIFY',
        SigningAlgorithms: ['ECDSA_SHA_256'], PublicKey: spki, ...state.keyPatch };
    },
    async sign(digest, signal) {
      state.signs++; state.signal = signal; assert.equal(digest.length, 32);
      if (state.hang) return new Promise(() => {});
      if (state.reject) throw Error('PRIVATE_PROVIDER_DIAGNOSTIC');
      const signature = await sign({ hash: bytesToHex(digest), privateKey });
      const s = state.high ? order - BigInt(signature.s) : BigInt(signature.s);
      return { KeyId: keyArn, SigningAlgorithm: 'ECDSA_SHA_256', Signature: der(BigInt(signature.r), s), ...state.signPatch };
    },
    destroy() { state.destroys++; },
  };
  const identity = { region: 'ap-northeast-2', keyArn, signerAddress: account.address };
  const custody = createKmsCustody({ identity, port, fees, limits, deadlineMs: 100 });
  return { state, custody, identity, port, spki };
}
test('KMS DER signatures preserve every EIP-1559 field and normalize either s over varied original nonces', async () => {
  const f = fixture();
  assert.equal(await f.custody.ready(), true); assert.equal(f.state.signs, 0);
  for (let n = 0; n < 24; n++) {
    f.state.high = n % 2 === 1;
    const raw = await f.custody.signOriginal({ ...request, nonce: BigInt(n) });
    const tx = parseTransaction(raw);
    assert.equal((await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase(), f.identity.signerAddress.toLowerCase());
    assert.equal(tx.chainId, 91342); assert.equal(tx.nonce, n); assert.equal(tx.to?.toLowerCase(), request.to);
    assert.equal(tx.data, request.data); assert.equal(tx.value ?? 0n, 0n);
    assert.equal(tx.gas, fees.gas); assert.equal(tx.maxFeePerGas, fees.maxFeePerGas);
    assert.equal(tx.maxPriorityFeePerGas, fees.maxPriorityFeePerGas); assert.ok(BigInt(tx.s!) <= order / 2n);
  }
  assert.equal(f.state.signs, 24);
  f.custody.close(); f.custody.close(); assert.equal(f.state.destroys, 1);
  assert.equal(await f.custody.ready(), false);
  await assert.rejects(f.custody.signOriginal(request), /SIGNER_KMS_UNAVAILABLE/);
  assert.equal(f.state.signs, 24);
});
test('identity rejects wrong ARN, curve, usage, algorithm and malformed or noncanonical SPKI before signing', async () => {
  for (const patch of [{ KeyId: keyArn.replace('123456789012:key', '999999999999:key') }, { KeySpec: 'ECC_NIST_P256' },
    { KeyUsage: 'ENCRYPT_DECRYPT' }, { SigningAlgorithms: ['ECDSA_SHA_384'] }, { PublicKey: new Uint8Array([1, 2]) },
    { PublicKey: Buffer.concat([fixture().spki, Buffer.from([0])]) }, { PublicKey: fixture().spki }]) {
    const f = fixture(); f.state.keyPatch = patch;
    assert.equal(await f.custody.ready(), false);
    await assert.rejects(f.custody.signOriginal(request), /^Error: SIGNER_KMS_UNAVAILABLE$/);
    assert.equal(f.state.signs, 0); f.custody.close();
  }
});
test('rejects malformed DER integers, zero/out-of-range scalars, wrong-key signatures and provider metadata', async () => {
  for (const patch of [{ KeyId: 'alias/other' }, { SigningAlgorithm: 'ECDSA_SHA_384' },
    ...['3006020100020101', '3006020180020101', '300702020001020101', '308106020101020101',
      '300602010102010100', '3006020101020201'].map(hex => ({ Signature: Buffer.from(hex, 'hex') })),
    { Signature: der(order, 1n) }, { Signature: der(1n, order) }, { Signature: der(1n, 1n) }]) {
    const f = fixture(); f.state.signPatch = patch;
    await assert.rejects(f.custody.signOriginal(request), /^Error: SIGNER_KMS_UNAVAILABLE$/);
    assert.equal(f.state.signs, 1); f.custody.close();
  }
});
test('provider exceptions and timeouts are sanitized, abort once, and never retried', async () => {
  for (const failure of ['reject', 'hang'] as const) {
    const f = fixture(); f.state[failure] = true;
    await assert.rejects(f.custody.signOriginal(request), /^Error: SIGNER_KMS_UNAVAILABLE$/);
    assert.equal(f.state.signs, 1); if (failure === 'hang') assert.equal(f.state.signal?.aborted, true);
    f.custody.close();
  }
});
test('fee ceilings, chain, nonce, calldata and immutable key ARN are enforced before signing', async () => {
  const f = fixture();
  for (const patch of [{ chainId: 1 }, { nonce: -1n }, { nonce: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
    { value: 1n }, { data: '0x0' }, { to: a(0) }]) {
    await assert.rejects(f.custody.signOriginal({ ...request, ...patch } as OriginalSignRequest), /SIGNER_KMS_UNAVAILABLE/);
  }
  for (const patch of [{ gas: limits.maxGas + 1n }, { maxFeePerGas: limits.maxFeePerGas + 1n },
    { maxPriorityFeePerGas: fees.maxFeePerGas + 1n }, { gas: 0n }])
    assert.throws(() => createKmsCustody({ identity: f.identity, fees: { ...fees, ...patch }, limits, port: f.port }));
  assert.throws(() => createKmsCustody({ identity: { ...f.identity, keyArn: 'alias/operator' }, fees, limits, port: f.port }));
  assert.throws(() => createKmsCustody({ identity: f.identity, fees, limits: { ...limits, maxTotalFeeWei: 1n }, port: f.port }));
  assert.equal(f.state.signs, 0); f.custody.close();
});
test('production SDK factory pins official endpoint, key, DIGEST and one attempt despite environment overrides', async t => {
  const original = KMSClient.prototype.send;
  let reads = 0, signs = 0;
  const previous = process.env.AWS_ENDPOINT_URL_KMS; process.env.AWS_ENDPOINT_URL_KMS = 'https://untrusted.invalid';
  t.after(() => { KMSClient.prototype.send = original;
    if (previous === undefined) delete process.env.AWS_ENDPOINT_URL_KMS; else process.env.AWS_ENDPOINT_URL_KMS = previous; });
  KMSClient.prototype.send = (async function(this: KMSClient, command: GetPublicKeyCommand | SignCommand, options: { abortSignal: AbortSignal }) {
    assert.equal(await this.config.maxAttempts(), 1);
    assert.equal((await this.config.endpoint!()).hostname, 'kms.ap-northeast-2.amazonaws.com');
    assert.equal(options.abortSignal.aborted, false);
    assert.equal(command.input.KeyId, keyArn);
    if (command instanceof GetPublicKeyCommand) reads++;
    else { signs++; assert.equal(command.input.MessageType, 'DIGEST'); assert.equal(command.input.SigningAlgorithm, 'ECDSA_SHA_256'); }
    return {};
  }) as typeof original;
  const f = fixture(); const port = awsKmsSigningPort(f.identity); t.after(() => port.destroy());
  const signal = new AbortController().signal;
  await port.getPublicKey(signal); await port.sign(new Uint8Array(32), signal);
  assert.equal(reads, 1); assert.equal(signs, 1); f.custody.close();
});

test('real SDK retry middleware sends a throttled Sign exactly once', async t => {
  const { NodeHttpHandler } = await import('@smithy/node-http-handler');
  const { Readable } = await import('node:stream');
  const { randomBytes } = await import('node:crypto');
  const original = NodeHttpHandler.prototype.handle;
  const saved = { access: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY, token: process.env.AWS_SESSION_TOKEN };
  // Random test-only IAM-shaped strings prevent default credential discovery;
  // the HTTP handler below intercepts every call before any network access.
  process.env.AWS_ACCESS_KEY_ID = randomBytes(10).toString('hex');
  process.env.AWS_SECRET_ACCESS_KEY = randomBytes(30).toString('base64');
  delete process.env.AWS_SESSION_TOKEN;
  t.after(() => {
    NodeHttpHandler.prototype.handle = original;
    for (const [name, value] of [['AWS_ACCESS_KEY_ID', saved.access], ['AWS_SECRET_ACCESS_KEY', saved.secret], ['AWS_SESSION_TOKEN', saved.token]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
  });
  let calls = 0;
  NodeHttpHandler.prototype.handle = async request => {
    calls++;
    assert.equal(request.hostname, 'kms.ap-northeast-2.amazonaws.com');
    const body = JSON.parse(typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body));
    assert.equal(body.MessageType, 'DIGEST'); assert.equal(body.SigningAlgorithm, 'ECDSA_SHA_256');
    assert.equal(body.KeyId, keyArn);
    return { response: { statusCode: 400, headers: { 'content-type': 'application/x-amz-json-1.1' },
      body: Readable.from([Buffer.from(JSON.stringify({ __type: 'ThrottlingException', message: 'TEST_ONLY' }))]) } };
  };
  const f = fixture(), port = awsKmsSigningPort(f.identity);
  t.after(() => { port.destroy(); f.custody.close(); });
  await assert.rejects(port.sign(new Uint8Array(32), new AbortController().signal));
  assert.equal(calls, 1);
});

test('public-key timeout never signs and a late signature cannot escape its deadline', async () => {
  const f = fixture();
  let keySignal: AbortSignal | undefined;
  const keyTimeout = createKmsCustody({ identity: f.identity, fees, limits, deadlineMs: 10,
    port: { ...f.port, getPublicKey: signal => { keySignal = signal; return new Promise(() => {}); } } });
  await assert.rejects(keyTimeout.signOriginal(request), /SIGNER_KMS_UNAVAILABLE/);
  assert.equal(keySignal?.aborted, true); assert.equal(f.state.signs, 0); keyTimeout.close();
  let release: (() => void) | undefined;
  const late = createKmsCustody({ identity: f.identity, fees, limits, deadlineMs: 10,
    port: { ...f.port, sign: async (digest, signal) => {
      await new Promise<void>(resolve => { release = resolve; });
      return f.port.sign(digest, signal);
    } } });
  await assert.rejects(late.signOriginal(request), /SIGNER_KMS_UNAVAILABLE/);
  release!(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.state.signs, 1); late.close(); f.custody.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseAbi, parseTransaction, zeroAddress, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { a, h, testManifest } from '../stocks/test-fixtures.js';
import { ABI, manifestDigest, type SqlPool } from '../stocks/contracts.js';
import type { ChainPort } from '../stocks/chain.js';
import { runStocksBootstrap, type BootstrapOptions } from './bootstrap-faucet.js';

const signer = mnemonicToAccount('test test test test test test test test test test test junk');
const recipient = a(22);
const limits = { maxGas: 200_000n, maxFeePerGas: 3_000_000_000n, maxTotalFeeWei: 600_000_000_000_000n };
function fixture() {
  const m = { ...testManifest(), signerAddress: signer.address.toLowerCase() as Hex };
  const records = new Map<string, unknown>();
  let account: Record<string, unknown> | undefined, pendingAccount: typeof account;
  const f = { sends: 0, signatures: 0, nonce: 7n, pendingNonce: 7n, finalized: true,
    visible: true, loseAck: false, mintAmount: 1000n, mintRecipient: recipient,
    network: m.checkpointHash, faucetRole: signer.address.toLowerCase(), txOverride: {} as Record<string, unknown>,
    signedOverride: {} as Record<string, unknown>, raw: undefined as Hex | undefined,
    records, get account() { return account; }, set account(value) { account = value; } };
  const pool: SqlPool = { async query() { throw Error('UNUSED'); }, async connect() {
    return { release() {}, async query(sql, values = []) {
      if (sql.startsWith('BEGIN')) pendingAccount = account;
      if (sql.startsWith('SELECT')) return { rows: pendingAccount ? [pendingAccount] : [], rowCount: pendingAccount ? 1 : 0 };
      if (sql.startsWith('INSERT')) {
        assert.equal(pendingAccount, undefined);
        pendingAccount = { networkInstance: values[1], checkpointNumber: values[2], checkpointHash: values[3], initialNonce: values[4], nextNonce: values[4] };
      }
      if (sql === 'COMMIT') account = pendingAccount;
      return { rows: [], rowCount: 1 };
    } };
  } };
  const block = (number: string) => ({ number, hash: number === '1' ? m.checkpointHash : h(10), timestamp: '100' });
  const chain: ChainPort = {
    network: async () => ({ chainId: 91342, networkInstance: m.networkInstance, checkpointHash: f.network }),
    block: async number => block(number === 'finalized' ? (f.finalized ? '10' : '9') : number),
    codeHash: async contract => m.codeHashes[contract.toLowerCase()],
    tokenBalance: async () => '0', tokenSupply: async () => '0',
    transaction: async () => f.raw && f.visible ? { hash: keccak256(f.raw), from: m.signerAddress, to: m.cashToken,
      input: parseTransaction(f.raw).data!, value: '0' } : null,
    receipt: async () => f.raw && f.visible ? { transactionHash: keccak256(f.raw), blockNumber: '10', blockHash: h(10), status: 'success', logs: [{
      address: m.cashToken, logIndex: 0, removed: false,
      topics: encodeEventTopics({ abi: ABI, eventName: 'Transfer', args: { from: zeroAddress, to: f.mintRecipient } }) as [Hex, ...Hex[]],
      data: encodeAbiParameters([{ type: 'uint256' }], [f.mintAmount]),
    }] } : null,
  };
  const getters = new Map<string, string>();
  const set = (target: string, getter: string, value: string) => getters.set(`${target}:${encodeFunctionData({ abi: parseAbi([`function ${getter}() view returns (address)`]), functionName: getter })}`, `0x${value.slice(2).padStart(64, '0')}`);
  for (const [target, getter, value] of [
    [m.stockToken, 'mintController', m.mintController], [m.stockToken, 'redemptionEscrow', m.redemptionEscrow],
    [m.fundingVault, 'cashToken', m.cashToken], [m.fundingVault, 'redemptionEscrow', m.redemptionEscrow], [m.fundingVault, 'operator', m.signerAddress],
    [m.mintController, 'stockToken', m.stockToken], [m.mintController, 'operator', m.signerAddress],
    [m.redemptionEscrow, 'stockToken', m.stockToken], [m.redemptionEscrow, 'cashToken', m.cashToken],
    [m.redemptionEscrow, 'fundingVault', m.fundingVault], [m.redemptionEscrow, 'operator', m.signerAddress],
  ]) set(target, getter, value);
  const decimals = encodeFunctionData({ abi: parseAbi(['function decimals() view returns (uint8)']), functionName: 'decimals' });
  const faucet = encodeFunctionData({ abi: parseAbi(['function faucetOperator() view returns (address)']), functionName: 'faucetOperator' });
  const options: BootstrapOptions = { manifest: m, reviewedManifestDigest: manifestDigest(m), recipient, amount: '1000', pool, chain, limits,
    store: { async read(name) { return structuredClone(records.get(name) ?? null); }, async create(name, value) {
      assert.equal(records.has(name), false); records.set(name, structuredClone(value));
    } },
    custody: { async signOriginal(request) {
      f.signatures++;
      return signer.signTransaction({ type: 'eip1559', ...request, nonce: Number(request.nonce), gas: 100_000n,
        maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, ...f.signedOverride });
    } },
    rpc: async (method, params) => {
      if (method === 'eth_call') {
        const input = params[0] as { to: string; data: string };
        if (input.data === decimals) return `0x${(input.to === m.cashToken ? '6' : '9').padStart(64, '0')}`;
        if (input.data === faucet) return `0x${f.faucetRole.slice(2).padStart(64, '0')}`;
        assert.ok(getters.has(`${input.to}:${input.data}`)); return getters.get(`${input.to}:${input.data}`);
      }
      if (method === 'eth_getTransactionCount') return `0x${(params[1] === 'pending' ? f.pendingNonce : f.nonce).toString(16)}`;
      if (method === 'eth_sendRawTransaction') {
        f.sends++; assert.ok(records.has('plan')); assert.ok(records.has('intent'));
        f.raw = params[0] as Hex; f.nonce++; f.pendingNonce++;
        if (f.loseAck) throw Error('TEST_ONLY_RESPONSE_LOST'); return keccak256(f.raw);
      }
      if (method === 'eth_getTransactionByHash') {
        if (!f.raw || !f.visible) return null;
        const tx = parseTransaction(f.raw);
        return { hash: keccak256(f.raw), from: m.signerAddress, to: tx.to, input: tx.data,
          chainId: '0x164ce', nonce: `0x${tx.nonce!.toString(16)}`, value: '0x0', ...f.txOverride };
      }
      throw Error(`UNEXPECTED_METHOD:${method}`);
    },
  };
  return { f, options, run: () => runStocksBootstrap(options) };
}

test('exact faucet original finalizes, seeds once, and matching completed handoff is read only', async () => {
  const { f, run } = fixture();
  const first = await run(); assert.equal(first.status, 'COMPLETE'); assert.equal(first.initialNonce, '8');
  assert.equal(f.account?.initialNonce, '8'); assert.equal(f.sends, 1); assert.equal(f.signatures, 1);
  assert.deepEqual(await run(), first); assert.equal(f.sends, 1); assert.equal(f.signatures, 1);
});
test('lost acknowledgement and unfinalized response recover same hash without resigning or rebroadcasting', async () => {
  const { f, run } = fixture(); f.loseAck = true; f.finalized = false;
  const first = await run(); assert.equal(first.status, 'PENDING'); assert.equal(f.account, undefined);
  assert.deepEqual(await run(), first); f.finalized = true;
  assert.equal((await run()).originalTransactionHash, first.originalTransactionHash);
  assert.equal(f.sends, 1); assert.equal(f.signatures, 1); assert.equal((f.account as Record<string, unknown> | undefined)?.initialNonce, '8');
});
test('unknown original stays pending and no second send is authorized', async () => {
  const { f, run } = fixture(); f.visible = false;
  const first = await run(); assert.equal(first.status, 'PENDING');
  assert.deepEqual(await run(), first); assert.equal(f.sends, 1); assert.equal(f.signatures, 1);
});
test('durable claim without signed hash and interrupted hash commit fail closed', async () => {
  for (const stage of ['plan', 'intent']) {
    const { f, options, run } = fixture();
    const create = options.store.create;
    options.store.create = async (name, value) => { await create(name, value); if (name === stage) throw Error('TEST_ONLY_COMMIT_ACK_LOST'); };
    await assert.rejects(run); assert.equal(f.sends, 0);
    options.store.create = create;
    if (stage === 'plan') await assert.rejects(run, /BOOTSTRAP_ORIGINAL_OUTCOME_UNKNOWN/);
    else assert.equal((await run()).status, 'PENDING');
    assert.equal(f.sends, 0); assert.equal(f.signatures, stage === 'plan' ? 0 : 1);
  }
});
test('crash after handoff persistence permits only original seed recovery', async () => {
  const { f, options, run } = fixture(); const create = options.store.create;
  options.store.create = async (name, value) => { await create(name, value); if (name === 'handoff') throw Error('TEST_ONLY_CRASH'); };
  await assert.rejects(run); assert.equal(f.account, undefined);
  options.store.create = create; assert.equal((await run()).status, 'COMPLETE'); assert.equal(f.sends, 1);
});
test('pre-existing seed forbids signing even with an empty local state', async () => {
  const { f, run } = fixture(); f.account = { initialNonce: '7' };
  await assert.rejects(run, /BOOTSTRAP_ACCOUNT_ALREADY_INITIALIZED/); assert.equal(f.sends + f.signatures, 0);
});
test('changed customer, amount, limits, manifest, and malformed persisted plan never authorize another original', async () => {
  for (const change of ['recipient', 'amount', 'limits', 'digest', 'plan']) {
    const { f, options, run } = fixture(); f.finalized = false; await run();
    if (change === 'recipient') options.recipient = a(23);
    if (change === 'amount') options.amount = '1001';
    if (change === 'limits') options.limits = { ...limits, maxGas: 100_001n };
    if (change === 'digest') options.reviewedManifestDigest = 'f'.repeat(64);
    if (change === 'plan') f.records.set('plan', { ...(f.records.get('plan') as object), extra: true });
    await assert.rejects(run); assert.equal(f.sends, 1); assert.equal(f.signatures, 1);
  }
});
test('invalid scope, role, checkpoint, busy nonce and fee policy fail before signing', async () => {
  for (const change of ['sameWallet', 'contract', 'zero', 'excess', 'number', 'numericType', 'role', 'checkpoint', 'nonce', 'fees']) {
    const { f, options, run } = fixture();
    if (change === 'sameWallet') options.recipient = options.manifest.signerAddress;
    if (change === 'contract') options.recipient = options.manifest.fundingVault;
    if (change === 'zero') options.amount = '0';
    if (change === 'excess') options.amount = '10000000001';
    if (change === 'number') options.amount = '1e3';
    if (change === 'numericType') options.amount = 1000 as unknown as string;
    if (change === 'role') f.faucetRole = a(24);
    if (change === 'checkpoint') f.network = h(44);
    if (change === 'nonce') f.pendingNonce++;
    if (change === 'fees') options.limits = { ...limits, maxGas: 2_000_001n };
    await assert.rejects(run); assert.equal(f.sends + f.signatures, 0);
  }
});
test('signed wrong target, amount, nonce, native value and fee overflow are never broadcast', async () => {
  for (const signedOverride of [{ to: a(24) }, { data: '0x12345678' }, { nonce: 8 }, { value: 1n }, { gas: 200_001n }]) {
    const { f, run } = fixture(); f.signedOverride = signedOverride;
    await assert.rejects(run, /SIGNER_SIGNED_TRANSACTION_MISMATCH/); assert.equal(f.sends, 0);
  }
});
test('wrong original transaction or mint proof never seeds the journal', async () => {
  for (const change of ['hash', 'nonce', 'to', 'chain', 'value', 'recipient', 'amount']) {
    const { f, run } = fixture();
    if (change === 'hash') f.txOverride = { hash: h(88) };
    if (change === 'nonce') f.txOverride = { nonce: '0x9' };
    if (change === 'to') f.txOverride = { to: a(88) };
    if (change === 'chain') f.txOverride = { chainId: '0x1' };
    if (change === 'value') f.txOverride = { value: '0x1' };
    if (change === 'recipient') f.mintRecipient = a(88);
    if (change === 'amount') f.mintAmount++;
    await assert.rejects(run); assert.equal(f.account, undefined); assert.equal(f.sends, 1);
  }
});

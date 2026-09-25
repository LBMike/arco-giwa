import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, type Hex } from 'viem';
import { freezeManifest, manifestDigest, publicManifest, validateManifest, type Manifest } from './contracts.js';
import { CASH_ADMIN_SLOT, CASH_IMPLEMENTATION_SLOT, verifyCashIdentity, verifyCurrentCashIdentity } from './cash-identity.js';
import { a, h, ACTOR, TestChain, testManifest, testTusdcManifest } from './test-fixtures.js';
import { ReceiptVerifier } from './chain.js';
import { createStocksRpcPort, type JsonRpcTransport } from './rpc.js';
import { deriveOrder } from '../stocks-submissions/contracts.js';
import { operationKey } from './contracts.js';

const word = (address: string) => `0x${address.slice(2).padStart(64, '0')}` as Hex;
test('v3 pins platform cash, proxy policy and digest; v2 cannot masquerade as tUSDC', () => {
    const m = testTusdcManifest();
    validateManifest(m);
    assert.deepEqual(publicManifest(m), m);
    assert.ok(Object.isFrozen(freezeManifest(m).cashIdentity));
    for (const patch of [{ cashToken: a(55) }, { cashSymbol: 'ARCO_TEST_USDC' }, { nonUpgradeable: true }, { stockContractsNonUpgradeable: false }, { cashIdentity: undefined }, { cashIdentity: { ...m.cashIdentity, unexpected: 'ignored?' } }]) {
        assert.throws(() => validateManifest({ ...m, ...patch } as unknown as Manifest));
    }
    assert.throws(() => validateManifest({ ...testManifest(), cashSymbol: 'tUSDC' } as unknown as Manifest));
    assert.throws(() => validateManifest({ ...testManifest(), cashIdentity: m.cashIdentity } as unknown as Manifest));
    assert.notEqual(manifestDigest(m), manifestDigest({ ...m, cashIdentity: { ...m.cashIdentity, implementation: a(203) } }));
});
test('historical proxy identity rejects changed implementation/admin/code and unavailable storage', async () => {
    const m = testTusdcManifest(), chain = new TestChain(m);
    await verifyCashIdentity(m, chain, '10');
    for (const slot of [CASH_IMPLEMENTATION_SLOT, CASH_ADMIN_SLOT]) {
        await assert.rejects(verifyCashIdentity(m, { codeHash: chain.codeHash.bind(chain), storageAt: async (target, readSlot) => readSlot === slot ? word(a(404)) : chain.storageAt(target, readSlot) }, '10'), /CASH_IDENTITY_MISMATCH/);
    }
    for (const target of [m.cashToken, m.cashIdentity.implementation, m.cashIdentity.proxyAdmin]) {
        await assert.rejects(verifyCashIdentity(m, { storageAt: chain.storageAt.bind(chain), codeHash: async readTarget => readTarget === target ? keccak256('0x6001') : keccak256('0x6000') }, '10'), /CASH_IDENTITY_MISMATCH/);
    }
    await assert.rejects(verifyCashIdentity(m, { codeHash: chain.codeHash.bind(chain) }, '10'), /CASH_IDENTITY_UNAVAILABLE/);
    await verifyCashIdentity(testManifest(), { codeHash: async () => assert.fail('v2 must not use proxy reads') }, '10');
});
test('funding receipts and cash snapshots require historical cash identity even if proxy bytecode is unchanged', async () => {
    const m = testTusdcManifest(), chain = new TestChain(m), verifier = new ReceiptVerifier(m, chain);
    chain.funding(h(88), '60000000');
    const proof = await verifier.fetch(h(200)); assert.ok(proof);
    assert.equal(verifier.funding(proof).amount, '60000000');
    chain.storageAt = async () => word(a(404));
    await assert.rejects(verifier.fetch(h(200)), /CASH_IDENTITY_MISMATCH/);
    await assert.rejects(verifier.latestSnapshot(), /CASH_IDENTITY_MISMATCH/);
});
test('latest identity detects upgrade ahead of finality and rejects chain/reorg failures', async () => {
    const m = testTusdcManifest();
    let changed = false, reorg = false, wrongChain = false;
    const rpc: JsonRpcTransport = async (method, args) => {
        if (method === 'eth_chainId') return wrongChain ? '0x1' : '0x164ce';
        if (method === 'eth_getBlockByNumber') return { number: '0xc8', hash: reorg && args[0] === '0xc8' ? h(201) : h(200) };
        if (method === 'eth_getCode') return '0x6000';
        if (method === 'eth_getStorageAt') {
            assert.equal(args[2], '0xc8');
            return word(args[1] === CASH_ADMIN_SLOT ? m.cashIdentity.proxyAdmin : changed ? a(300) : m.cashIdentity.implementation);
        }
        return assert.fail(method);
    };
    await verifyCurrentCashIdentity(m, rpc);
    changed = true; await assert.rejects(verifyCurrentCashIdentity(m, rpc), /CASH_IDENTITY_MISMATCH/);
    changed = false; reorg = true; await assert.rejects(verifyCurrentCashIdentity(m, rpc), /CASH_IDENTITY_BLOCK_CHANGED/);
    reorg = false; wrongChain = true; await assert.rejects(verifyCurrentCashIdentity(m, rpc), /CASH_IDENTITY_NETWORK_MISMATCH/);
});
test('RPC storage reads are block-pinned and require one complete word', async () => {
    const m = testTusdcManifest(); let value = word(m.cashIdentity.implementation);
    const rpc = createStocksRpcPort(async (method, args) => { assert.equal(method, 'eth_getStorageAt'); assert.deepEqual(args, [m.cashToken, CASH_IMPLEMENTATION_SLOT, '0xa']); return value; }, m);
    assert.equal(await rpc.storageAt!(m.cashToken, CASH_IMPLEMENTATION_SLOT, '10'), value);
    value = '0x01'; await assert.rejects(rpc.storageAt!(m.cashToken, CASH_IMPLEMENTATION_SLOT, '10'), /INVALID_STORAGE_RESULT/);
});
test('tUSDC BUY plans use platform cash and SELL plans target the paired stock escrow', () => {
    const m = testTusdcManifest(), id = 'TEST_ORDER_025';
    const order = { id, wallet: ACTOR.wallet, symbol: 'NVDA', quantity: '500000000', cashAmount: '60000000', orderKey: operationKey(`${m.networkInstance}:${id}`) };
    const buy = deriveOrder(m, order, 'BUY');
    assert.equal(buy.approval.to.toLowerCase(), m.cashToken);
    assert.equal(buy.transfer.to.toLowerCase(), m.fundingVault);
    const sell = deriveOrder(m, { ...order, orderKey: operationKey(`sell:${m.networkInstance}:${id}`) }, 'SELL');
    assert.equal(sell.approval.to.toLowerCase(), m.stockToken);
    assert.equal(sell.transfer.to.toLowerCase(), m.redemptionEscrow);
});

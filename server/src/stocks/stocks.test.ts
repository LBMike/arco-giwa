import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { zeroAddress } from 'viem';
import { units, validateManifest, manifestDigest, callDigest, liquidityScope, StocksError, type SqlPool } from './contracts.js';
import { authorizedCall, ReceiptVerifier, redemptionCall } from './chain.js';
import { stocksPlugin } from './plugin.js';
import { StocksRepository } from './repository.js';
import { StocksService } from './service.js';
import { createStocksRpcPort } from './rpc.js';
import { a, h, ACTOR, eventLog, TestChain, testManifest } from './test-fixtures.js';
test('exact decimal math rejects floats, exponents, precision loss, zero and overflow', () => {
    assert.equal(units('123456789012345678901.123456789', 9), 123456789012345678901123456789n);
    for (const value of [1.2, '1e2', '-1', '0', '01', '1.0000000001', '9'.repeat(40)])
        assert.throws(() => units(value, 9), StocksError);
});
test('manifest requires GIWA demo, exact ABI, finality, restricted nonupgradeable deployment and test cash', () => {
    const m = testManifest();
    validateManifest(m);
    for (const patch of [{ chainId: 1 }, { abiDigest: 'arbitrary' }, { finalityPolicy: 'SAFE' }, { restrictedTransfers: false }, { cashSymbol: 'USDC' }, { stockToken: zeroAddress }, { nonUpgradeable: false }])
        assert.throws(() => validateManifest({ ...m, ...patch } as never));
});
test('physical liquidity scope ignores aliases and checkpoints but distinguishes cash pools', () => {
    const m = testManifest();
    const renamed = { ...m, deploymentId: 'ANOTHER_DEPLOYMENT', networkInstance: 'ANOTHER_NETWORK_ALIAS', checkpointNumber: '2', checkpointHash: h(2) };
    assert.equal(liquidityScope(renamed), liquidityScope(m));
    assert.equal(liquidityScope(m), `cash:91342:${m.fundingVault.toLowerCase()}:${m.cashToken.toLowerCase()}`);
    assert.notEqual(liquidityScope({ ...m, fundingVault: a(900) }), liquidityScope(m));
    assert.notEqual(liquidityScope({ ...m, cashToken: a(901) }), liquidityScope(m));
});
test('verifier deep freezes manifest and confirms canonical finalized attributed deposit', async () => {
    const m = testManifest();
    const rpc = new TestChain(m);
    const verifier = new ReceiptVerifier(m, rpc);
    const id = rpc.funding(h(500), '120000000');
    m.codeHashes[a(100)] = h(888);
    m.cashToken = a(555);
    const proof = await verifier.fetch(id);
    assert.ok(proof);
    assert.equal(verifier.funding(proof).amount, '120000000');
    assert.equal(verifier.manifest.cashToken, a(100));
    assert.equal(Object.isFrozen(verifier.manifest.codeHashes), true);
});
test('unfinalized, reorg and pending receipts cannot produce evidence', async () => {
    const m = testManifest();
    const rpc = new TestChain(m);
    const verifier = new ReceiptVerifier(m, rpc);
    assert.equal(await verifier.fetch(h(999)), null);
    const id = rpc.funding(h(500), '120000000');
    rpc.finalizedNumber = '1';
    assert.equal(await verifier.fetch(id), null);
    rpc.finalizedNumber = '100';
    rpc.blocks.get('10')!.hash = h(900);
    assert.equal(await verifier.fetch(id), null);
});
test('raw funding rejects chain, code, target, calldata, token, payer, movement and failed receipts', async () => {
    for (const mutation of [
        (rpc: TestChain) => { rpc.wrongChain = true; }, (rpc: TestChain) => { rpc.wrongCode = true; },
        (rpc: TestChain) => { rpc.transactions.get(h(200))!.to = a(500); },
        (rpc: TestChain) => { rpc.transactions.get(h(200))!.input = '0x'; },
        (rpc: TestChain) => { rpc.transactions.get(h(200))!.from = a(500); },
        (rpc: TestChain) => { rpc.receipts.get(h(200))!.status = 'reverted'; },
        (rpc: TestChain) => { rpc.receipts.get(h(200))!.logs[1] = eventLog(rpc.m.cashToken, 'Transfer', { from: ACTOR.wallet, to: rpc.m.fundingVault, value: 1n }, 1); },
        (rpc: TestChain) => { rpc.receipts.get(h(200))!.logs[0] = eventLog(rpc.m.fundingVault, 'FundingReceived', { orderKey: h(500), payer: ACTOR.wallet, token: a(900), amount: 120000000n }, 0); },
    ]) {
        const m = testManifest();
        const rpc = new TestChain(m);
        const v = new ReceiptVerifier(m, rpc);
        rpc.funding(h(500), '120000000');
        mutation(rpc);
        await assert.rejects(async () => v.funding((await v.fetch(h(200)))!));
    }
});
test('unknown unrelated log ignored, malformed known event rejected, direct transfer retained unallocated', async () => {
    const m = testManifest();
    const rpc = new TestChain(m);
    const v = new ReceiptVerifier(m, rpc);
    const id = rpc.funding(h(500), '120000000');
    rpc.receipts.get(id)!.logs.push({ address: m.cashToken, topics: [h(888)], data: '0x', logIndex: 9, removed: false });
    assert.equal(v.funding((await v.fetch(id))!).amount, '120000000');
    rpc.receipts.get(id)!.logs[0].data = '0x';
    await assert.rejects(() => v.fetch(id));
    rpc.receipts.get(id)!.logs.shift();
    const unallocated = v.unallocated((await v.fetch(id))!);
    assert.equal(unallocated[0].amount, '120000000');
});
test('mint confirmation binds operation/call/recipient/quantity and ERC20 zero-address transfer', async () => {
    const m = testManifest();
    const rpc = new TestChain(m);
    const v = new ReceiptVerifier(m, rpc);
    const call = authorizedCall(m, 'mint:test', 'MINT', ACTOR.wallet, '1000000000');
    rpc.confirmation(call, '1000000000', ACTOR.wallet, 'MINT', h(700));
    const proof = (await v.fetch(h(700)))!;
    v.confirmation(proof, call, 'MINT', '1000000000', ACTOR.wallet);
    assert.throws(() => v.confirmation(proof, call, 'MINT', '2000000000', ACTOR.wallet));
    assert.throws(() => v.confirmation(proof, { ...call, operationId: 'mint:other' }, 'MINT', '1000000000', ACTOR.wallet));
    assert.throws(() => v.confirmation(proof, call, 'MINT', '1000000000', a(88)));
});
test('read-only RPC adapter requests finalized tag and rejects malformed quantities and log identity', async () => {
    const m = testManifest();
    const seen: string[] = [];
    const port = createStocksRpcPort(async (method, params) => {
        seen.push(`${method}:${params[0]}`);
        if (method === 'eth_chainId')
            return '0x164ce';
        if (method === 'eth_getBlockByNumber')
            return { number: '0x1', hash: h(1), timestamp: '0x2' };
        if (method === 'eth_getCode')
            return '0x6000';
        if (method === 'eth_call')
            return `0x${'1'.padStart(64, '0')}`;
        return null;
    }, m);
    assert.equal((await port.block('finalized'))!.number, '1');
    assert.ok(seen.includes('eth_getBlockByNumber:finalized'));
    assert.equal(await port.tokenBalance(m.cashToken, m.fundingVault, '1'), '1');
    const bad = createStocksRpcPort(async () => '91342', m);
    await assert.rejects(() => bad.network());
});
test('HTTP fails closed without resolvers; forged role/wallet rejected and no money mutation/admin writes exposed', async () => {
    const m = testManifest();
    const rpc = new TestChain(m);
    const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as SqlPool;
    const repo = new StocksRepository(pool, manifestDigest(m));
    const service = new StocksService(repo, m, new ReceiptVerifier(m, rpc));
    const app = Fastify();
    await app.register(stocksPlugin, { service });
    assert.equal((await app.inject({ url: '/api/v1/stocks/catalog' })).statusCode, 200);
    for (const url of ['/api/v1/stocks/orders', '/api/v1/stocks/portfolio', '/api/v1/stocks/orders/id'])
        assert.equal((await app.inject({ url, headers: { 'x-actor-id': 'fake' } })).statusCode, 401);
    for (const path of ['overview', 'orders', 'orders/id', 'reconciliations', 'audit'])
        assert.equal((await app.inject({ url: `/api/v1/admin/stocks/${path}`, headers: { 'x-role': 'admin' } })).statusCode, 403);
    for (const path of ['mint', 'funding', 'confirm', 'faucet'])
        assert.equal((await app.inject({ method: 'POST', url: `/api/v1/stocks/${path}` })).statusCode, 404);
    await app.close();
    const authorized = Fastify();
    await authorized.register(stocksPlugin, { service, resolveActor: async () => ACTOR, resolveOperator: async () => ({ operatorId: 'named-reader', permissions: ['stocks:read'] }) });
    assert.equal((await authorized.inject({ method: 'POST', url: '/api/v1/stocks/quotes', payload: { symbol: 'NVDA', quantity: '1', wallet: a(88) } })).statusCode, 400);
    assert.equal((await authorized.inject({ method: 'POST', url: '/api/v1/stocks/quotes', payload: { symbol: 'NVDA', quantity: '1' } })).statusCode, 503);
    const reconciliation = await authorized.inject({ url: '/api/v1/admin/stocks/reconciliations' });
    assert.equal(reconciliation.json().data.status, 'UNAVAILABLE');
    assert.equal((await authorized.inject({ method: 'POST', url: '/api/v1/admin/stocks/orders/id', payload: { state: 'COMPLETED' } })).statusCode, 404);
    await authorized.close();
});
test('RPC adapter to verifier accepts real ERC20 mint zero-from topic and verifies its movement', async () => {
    const m = testManifest();
    const chain = new TestChain(m);
    const call = authorizedCall(m, 'mint:rpc-real-shape', 'MINT', ACTOR.wallet, '1000000000');
    chain.confirmation(call, '1000000000', ACTOR.wallet, 'MINT', h(777));
    const hex = (v: string) => `0x${BigInt(v).toString(16)}`;
    const port = createStocksRpcPort(async (method, params) => {
        if (method === 'eth_chainId')
            return hex('91342');
        if (method === 'eth_getCode')
            return '0x6000';
        if (method === 'eth_getBlockByNumber') {
            const block = await chain.block(params[0] === 'finalized' ? 'finalized' : BigInt(params[0] as string).toString());
            return block && { ...block, number: hex(block.number), timestamp: hex(block.timestamp) };
        }
        if (method === 'eth_getTransactionByHash') {
            const tx = chain.transactions.get(params[0] as string);
            return tx && { ...tx, value: hex(tx.value) };
        }
        if (method === 'eth_getTransactionReceipt') {
            const receipt = chain.receipts.get(params[0] as string);
            return receipt && { ...receipt, blockNumber: hex(receipt.blockNumber), status: '0x1', logs: receipt.logs.map(log => ({ ...log, logIndex: hex(log.logIndex.toString()), transactionHash: receipt.transactionHash, blockHash: receipt.blockHash, blockNumber: hex(receipt.blockNumber) })) };
        }
        throw new Error('Unexpected test RPC method');
    }, m);
    const verifier = new ReceiptVerifier(m, port);
    const proof = await verifier.fetch(h(777));
    assert.ok(proof);
    verifier.confirmation(proof, call, 'MINT', '1000000000', ACTOR.wallet);
});
test('canonical call digest survives JSONB key reordering and binds every call identity field', () => {
    const m = testManifest();
    const call = authorizedCall(m, 'mint:digest', 'MINT', ACTOR.wallet, '1000000000');
    const reordered = Object.fromEntries(Object.entries(call).reverse()) as typeof call;
    assert.equal(callDigest(call), callDigest(reordered));
    for (const patch of [{ operationId: 'mint:other' }, { networkInstance: 'other' }, { deploymentId: 'other' }, { from: a(99) }, { to: a(99) }, { data: '0x00' }, { value: '1' }, { chainId: 1 }])
        assert.notEqual(callDigest(call), callDigest({ ...call, ...patch } as typeof call));
    const reorderedManifest = Object.fromEntries(Object.entries(m).reverse()) as typeof m;
    assert.equal(manifestDigest(m), manifestDigest(reorderedManifest));
});
test('manifest v2 rejects old generation, missing escrow and duplicate constructor targets', () => {
    const m = testManifest();
    assert.throws(() => validateManifest({ ...m, schemaVersion: undefined } as never));
    assert.throws(() => validateManifest({ ...m, redemptionEscrow: undefined } as never));
    assert.throws(() => validateManifest({ ...m, redemptionEscrow: m.fundingVault }));
});
test('escrow verifier binds composite identity, owner, quantity and atomic burn/payout pair', async () => {
    const m = testManifest();
    const chain = new TestChain(m);
    const verifier = new ReceiptVerifier(m, chain);
    const raw = chain.escrow(h(900), '1000000000');
    const fact = verifier.escrow((await verifier.fetch(raw.txHash))!);
    assert.equal(fact.quantity, '1000000000');
    const call = redemptionCall(m, 'redeem:test', 'REDEEM', raw.escrowId, '120000000');
    chain.redeem(call, raw.escrowId, '1000000000', '120000000', ACTOR.wallet, 'REDEEM', h(901));
    const proof = (await verifier.fetch(h(901)))!;
    verifier.redemption(proof, call, 'REDEEM', raw.escrowId, ACTOR.wallet, '1000000000', '120000000');
    assert.throws(() => verifier.redemption(proof, call, 'REDEEM', raw.escrowId, a(88), '1000000000', '120000000'));
    chain.receipts.get(h(901))!.logs.pop();
    const noPayout = (await verifier.fetch(h(901)))!;
    assert.throws(() => verifier.redemption(noPayout, call, 'REDEEM', raw.escrowId, ACTOR.wallet, '1000000000', '120000000'), /ERC20_MOVEMENT_MISMATCH/);
});

// Disposable native HTTP -> PostgreSQL -> unforked local EVM evidence only.
// No browser, personal wallet, existing DB, public RPC or configurable product upstream.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { getAddress, stringToHex } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { customerGateway, CUSTOMER_API } from './gateway.ts';
import { createLocalUiStack } from '../stocks-local/ui-stack.mjs';
import { deriveOrder, digest } from '../../server/dist/stocks-submissions/contracts.js';

export async function runStack(options) {
  assert.equal(process.env.STOCKS_LOCAL_STACK_ONLY, '1');
  assert.equal(process.env.STOCKS_LOCAL_CUSTOMER_GATEWAY, '1');
  let handler, stack, closePromise, dropOrderResponse = true;
  const forwarded = [];
  const server = createServer((req, res) => {
    if (!handler) { res.writeHead(503); res.end(); return; }
    void handler(req, res, () => { res.writeHead(404); res.end(); });
  });
  const close = () => closePromise ??= (async () => {
    server.closeAllConnections();
    await new Promise((done, fail) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? fail(error) : done()));
    await stack?.close();
  })();
  options.registerCleanup?.(close);
  try {
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${server.address().port}`;
    stack = await createLocalUiStack({ ...options, frontendOrigin: origin });
    assert.equal(new URL(stack.apiBase).hostname, '127.0.0.1');
    handler = customerGateway({ origin, authEnabled: true, tradesEnabled: true,
      fetcher: async (url, init) => {
        const target = new URL(url);
        assert.equal(target.origin, CUSTOMER_API);
        assert.ok(target.pathname.startsWith('/api/v1/'));
        assert.ok(!target.search && !target.hash);
        forwarded.push({ path: target.pathname, method: init.method });
        const answer = await fetch(stack.apiBase + target.pathname, init);
        if (dropOrderResponse && target.pathname === '/api/v1/stocks/orders' && init.method === 'POST') {
          assert.equal(answer.status, 200);
          await answer.arrayBuffer(); // The real DB committed before the response was lost.
          dropOrderResponse = false;
          throw new Error('LOCAL_ACCEPTED_ORDER_RESPONSE_LOST');
        }
        return answer;
      },
    });
    let token;
    async function api(path, body, expected = 200) {
      const response = await fetch(origin + '/api/v1/' + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { origin, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000),
      });
      assert.equal(response.status, expected, `Gateway status for ${path}`);
      const row = await response.json();
      return Object.hasOwn(row, 'data') ? row.data : row;
    }
    const wallet = stack.accounts.holder, domain = new URL(origin).host;
    const nonce = await api('auth/nonce', { walletAddress: wallet, domain });
    const message = createSiweMessage({ address: getAddress(wallet), chainId: 91342, domain, uri: origin, version: '1', nonce: nonce.nonce });
    const signature = await stack.rpc('personal_sign', [stringToHex(message), wallet]);
    token = (await api('auth/verify', { message, signature })).token;
    assert.ok(token);
    const catalog = await api('stocks/catalog');
    assert.equal(catalog.profile, 'DEMO_TESTNET');
    const deployment = await api('stocks/execution/deployment');
    assert.equal(deployment.status, 'VERIFIED'); assert.equal(deployment.manifestDigest, stack.digest);

    const buyQuote = await api('stocks/quotes', { symbol: 'NVDA', quantity: '2' });
    const buyBody = { quoteId: buyQuote.id, idempotencyKey: 'customer-gateway-original-buy' };
    await api('stocks/orders', buyBody, 502);
    await stack.restartApi();
    const buy = await api('stocks/orders/recover', buyBody);
    assert.equal(buy.quoteId, buyQuote.id);
    assert.equal(forwarded.filter(row => row.path === '/api/v1/stocks/orders' && row.method === 'POST').length, 1);
    assert.equal((await stack.snapshot()).buyOrders.length, 1);

    async function payment(order, side) {
      const policy = await api(`stocks/execution/${side}/${order.id}`);
      assert.equal(policy.allowed, true);
      const plan = deriveOrder(stack.manifest, order, side);
      for (const stage of ['APPROVAL', 'TRANSFER']) {
        const transaction = stage === 'APPROVAL' ? plan.approval : plan.transfer;
        const request = { side, orderId: order.id, intentKey: plan.intentKey, stage,
          transactionDigest: digest(transaction), transaction, deploymentDigest: stack.digest };
        const claim = await api('stocks/wallet-submissions/claims', request);
        assert.equal(claim.status, 'REQUEST_MAY_START');
        assert.equal(await api('stocks/wallet-submissions/claims', request), null, 'Replay cannot grant a second wallet request');
        const txHash = await stack.rpc('eth_sendTransaction', [{ from: transaction.from, to: transaction.to,
          data: transaction.data, value: '0x0', gas: '0x1e8480' }]);
        for (let n = 0; n < 40; n++) {
          const receipt = await stack.rpc('eth_getTransactionReceipt', [txHash]);
          if (receipt) { assert.equal(receipt.status, '0x1'); break; }
          assert.ok(n < 39, 'Local receipt missing'); await delay(50);
        }
        await api('stocks/wallet-submissions/outcomes', { ...claim, status: 'SUBMITTED', txHash });
        const reconciled = await api('stocks/wallet-submissions/reconcile', {
          claimId: claim.claimId, intentKey: claim.intentKey, stage, transactionDigest: claim.transactionDigest, txHash,
        });
        assert.equal(reconciled.status, 'CONFIRMED');
        const inspected = await api(`stocks/wallet-submissions/${side}/${order.id}`);
        assert.equal(inspected[stage === 'APPROVAL' ? 'approval' : 'transfer'].txHash, txHash);
      }
    }
    async function settled(path, id, terminal) {
      for (let n = 0; n < 160; n++) {
        const order = await api(`stocks/${path}/${id}`);
        if (order.state === terminal) return;
        await delay(100);
      }
      assert.fail(`Order did not reach ${terminal}`);
    }
    await payment(buy, 'BUY');
    await settled('orders', buy.id, 'COMPLETED');
    const sellQuote = await api('stocks/sell-quotes', { symbol: 'NVDA', quantity: '0.5' });
    const sellBody = { quoteId: sellQuote.id, idempotencyKey: 'customer-gateway-original-sell' };
    const sell = await api('stocks/sell-orders', sellBody);
    await payment(sell, 'SELL');
    await settled('sell-orders', sell.id, 'COMPLETED');
    const before = await stack.snapshot();
    await stack.restartApi();
    assert.equal((await api('stocks/orders/recover', buyBody)).id, buy.id);
    assert.equal((await api('stocks/sell-orders/recover', sellBody)).id, sell.id);
    const portfolio = await api('stocks/portfolio');
    const after = await stack.snapshot();
    assert.deepEqual(portfolio, after.portfolio);
    assert.equal(after.buyOrders.length, 1); assert.equal(after.sellOrders.length, 1); assert.equal(after.claims.length, 4);
    assert.equal(after.rpcTrace.filter(row => row.method === 'eth_sendTransaction').length,
      before.rpcTrace.filter(row => row.method === 'eth_sendTransaction').length, 'Restart/recovery cannot send a wallet transaction');
    assert.equal(after.signer.operations.length, before.signer.operations.length);
    for (const [key, value] of Object.entries({ holderStock: '1500000000', holderCash: '1820000000', vaultCash: '180000000', escrowStock: '0' })) assert.equal(after.chain[key], value);
    assert.equal(after.reconciliation.status, 'MATCHED_AT_CUTOFF');
    assert.deepEqual(after.workerErrors, { processing: [], reviewJobs: [] });
    return { result: 'PASS', execution: 'LOCAL_CUSTOMER_GATEWAY_ONLY',
      checks: ['real SIWE', 'buy and partial sell', 'committed response loss and original-order recovery', 'duplicate claim denied', 'API restart preserves records without sends'],
      final: { holderStock: after.chain.holderStock, holderCash: after.chain.holderCash, vaultCash: after.chain.vaultCash, escrowStock: after.chain.escrowStock,
        buyOrders: after.buyOrders.length, sellOrders: after.sellOrders.length, claims: after.claims.length, reconciliation: after.reconciliation.status } };
  } finally { await close(); }
}

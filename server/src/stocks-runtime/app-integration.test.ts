import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { buildApp, type AppEnv, type ArcoAppServices } from '../app.js';
import { StocksError, type Actor } from '../stocks/contracts.js';
import type { StocksPluginOptions } from '../stocks/plugin.js';
import type { StocksService } from '../stocks/service.js';
import { a } from '../stocks/test-fixtures.js';
import { stocksSessionResolvers } from './session.js';

const require = createRequire(import.meta.url);
const { sign } = require('jsonwebtoken') as typeof import('jsonwebtoken');
const domain = 'stocks-app-integration.test';
const env: AppEnv = {
    corsAllowedOrigins: [`https://${domain}`],
    authNonceTtlSeconds: 60,
    authJwtSecret: `TEST_HARNESS_ONLY_${randomUUID()}`,
    adminOperatorToken: 'TEST_HARNESS_ONLY_LEGACY_OPERATOR',
    registryPath: '/TEST_HARNESS_ONLY_NO_REGISTRY_FILE',
};
const wallet = a(10);
const otherWallet = a(11);
const operatorWallet = a(12);
function session(sub = wallet, extra: Record<string, unknown> = {}) {
    return sign({ sub, domain, chainId: 91342, ...extra }, env.authJwtSecret, { algorithm: 'HS256', expiresIn: '15m' });
}
function headers(token = session()) { return { authorization: `Bearer ${token}` }; }

// Only the legacy methods exercised below are implemented. The real buildApp
// still registers every legacy route; accidental calls fail instead of hitting a
// deployed registry or an unrelated database.
function legacyFixture() {
    const nonces: Record<string, unknown>[] = [];
    const services = {
        arco: {
            issueAuthNonce: async (value: Record<string, unknown>) => { nonces.push(value); },
            createWalletAttestation: async (value: Record<string, unknown>) => ({ ...value, id: 'legacy-attestation' }),
            vaultConfigs: async () => [],
        },
        registry: {
            listNetworks: async () => [{ chainId: 91342, fixture: 'LEGACY' }],
            getRegistry: async () => ({ network: { chainId: 91342 }, assets: [], products: [] }),
        },
        portfolio: { portfolio: async (owner: string) => ({ walletAddress: owner, products: [] }) },
        readiness: { check: async () => ({ ok: true, checks: { testFixture: { ok: true } } }) },
        loadRegistry: () => { throw new Error('TEST_MUST_NOT_READ_DEPLOYED_REGISTRY'); },
    } as unknown as ArcoAppServices;
    return { services, nonces };
}

// This fixture is a route-boundary spy, not a money engine. Actual quotes,
// persistence, observer, worker and EVM settlement run in stocks-local/stack.mjs.
function stocksBoundaryFixture() {
    type Row = { id: string; actorId: string; wallet: string; side: 'BUY' | 'SELL'; quoteId?: string };
    const calls: { method: string; actorId?: string; wallet?: string }[] = [];
    const quotes: Row[] = [];
    const orders: Row[] = [];
    const quote = async (side: 'BUY' | 'SELL', actor: Actor) => {
        calls.push({ method: `${side}:quote`, actorId: actor.actorId, wallet: actor.wallet });
        const row: Row = { id: randomUUID(), actorId: actor.actorId, wallet: actor.wallet, side };
        quotes.push(row);
        return row;
    };
    const create = async (side: 'BUY' | 'SELL', actor: Actor, quoteId: string) => {
        const source = quotes.find(row => row.id === quoteId && row.actorId === actor.actorId && row.side === side);
        if (!source) throw new StocksError('QUOTE_NOT_FOUND', 404);
        calls.push({ method: `${side}:order`, actorId: actor.actorId, wallet: actor.wallet });
        const row = { ...source, id: randomUUID(), quoteId };
        orders.push(row);
        return row;
    };
    const list = (side: 'BUY' | 'SELL', actorId: string, id?: string) => orders.filter(row => row.side === side && row.actorId === actorId && (!id || row.id === id));
    const service = {
        catalog: () => ({ profile: 'DEMO_TESTNET', instruments: [{ symbol: 'NVDA' }] }),
        currentCatalog: async () => ({ profile: 'DEMO_TESTNET', instruments: [{ symbol: 'NVDA' }] }),
        quote: (actor: Actor) => quote('BUY', actor),
        createOrder: (actor: Actor, quoteId: string) => create('BUY', actor, quoteId),
        sell: {
            quote: (actor: Actor) => quote('SELL', actor),
            createOrder: (actor: Actor, quoteId: string) => create('SELL', actor, quoteId),
        },
        repo: {
            scopedOrders: async (actorId: string, id?: string) => list('BUY', actorId, id),
            sellOrders: async (actorId: string, id?: string) => list('SELL', actorId, id),
            portfolio: async (actorId: string) => ({ holdings: [], pending: orders.filter(row => row.actorId === actorId) }),
            admin: async (kind: string) => { calls.push({ method: `admin:${kind}` }); return orders; },
            adminOrder: async (id: string) => ({ order: orders.find(row => row.id === id), audit: [] }),
        },
    } as unknown as StocksService;
    const stocks: StocksPluginOptions = {
        service,
        ...stocksSessionResolvers(env.authJwtSecret, [domain], [{ wallet: operatorWallet, operatorId: 'named-test-operator', permissions: ['stocks:read'] }]),
    };
    return { stocks, calls };
}

async function assertLegacy(app: ReturnType<typeof buildApp>) {
    assert.deepEqual((await app.inject('/health')).json(), { ok: true, service: 'arco-giwa-api' });
    assert.equal((await app.inject('/ready')).statusCode, 200);
    assert.deepEqual((await app.inject('/api/v1/evm/networks')).json(), [{ chainId: 91342, fixture: 'LEGACY' }]);
    assert.deepEqual((await app.inject('/api/v1/evm/catalog/91342')).json(), []);
    assert.equal((await app.inject(`/api/v1/portfolio/${wallet}`)).json().walletAddress, wallet);
    const nonce = await app.inject({ method: 'POST', url: '/api/v1/auth/nonce', payload: { walletAddress: wallet, domain } });
    assert.equal(nonce.statusCode, 200);
    assert.equal(nonce.json().domain, domain);
    assert.match(nonce.json().nonce, /^[a-zA-Z0-9]{8,}$/);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/verify', payload: {} })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/attestations', payload: {} })).statusCode, 401);
    const attestation = await app.inject({ method: 'POST', url: '/api/v1/attestations', headers: headers(), payload: {} });
    assert.equal(attestation.statusCode, 200);
    assert.equal(attestation.json().walletAddress, wallet);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/admin/wallets/${wallet}/greenlist`, payload: {} })).statusCode, 401);
    const invalidLegacy = await app.inject('/api/v1/evm/registry/not-a-chain');
    assert.equal(invalidLegacy.statusCode, 400);
    assert.match(invalidLegacy.json().error, /chainId must be an integer/);
    assert.equal(invalidLegacy.json().profile, undefined, 'Stocks error handler must not replace legacy errors');
}

test('buildApp without Stocks preserves legacy health/auth/catalog and has no Stocks routes', async () => {
    const legacy = legacyFixture();
    const app = buildApp(env, legacy.services);
    try {
        await assertLegacy(app);
        assert.equal(legacy.nonces.length, 1);
        assert.equal(legacy.nonces[0].walletAddress, wallet);
        for (const url of ['/api/v1/stocks/catalog', '/api/v1/stocks/orders', '/api/v1/admin/stocks/overview'])
            assert.equal((await app.inject(url)).statusCode, 404);
        for (const url of ['/api/v1/stocks/quotes', '/api/v1/stocks/sell-orders'])
            assert.equal((await app.inject({ method: 'POST', url, payload: {} })).statusCode, 404);
    } finally { await app.close(); }
});

test('buildApp configured Stocks exposes signed-session BUY/SELL and named read-only admin while retaining legacy routes', async () => {
    const fixture = stocksBoundaryFixture();
    // Structural extension compiles before the Commander's app.ts change is
    // assembled; nothing manually registers stocksPlugin in this test.
    const services: ArcoAppServices & { stocks: StocksPluginOptions } = { ...legacyFixture().services, stocks: fixture.stocks };
    const app = buildApp(env, services);
    try {
        await assertLegacy(app);
        assert.equal((await app.inject('/api/v1/stocks/catalog')).statusCode, 200);
        for (const side of ['BUY', 'SELL'] as const) {
            const prefix = side === 'BUY' ? '' : 'sell-';
            const quote = await app.inject({ method: 'POST', url: `/api/v1/stocks/${prefix}quotes`, headers: headers(), payload: { symbol: 'NVDA', quantity: '1' } });
            assert.equal(quote.statusCode, 200, quote.body);
            assert.equal(quote.json().data.wallet, wallet);
            const order = await app.inject({ method: 'POST', url: `/api/v1/stocks/${prefix}orders`, headers: headers(), payload: { quoteId: quote.json().data.id, idempotencyKey: `integration-${side}` } });
            assert.equal(order.statusCode, 200, order.body);
            assert.equal(order.json().data.side, side);
            const detail = `/api/v1/stocks/${prefix}orders/${order.json().data.id}`;
            assert.equal((await app.inject({ url: detail, headers: headers() })).statusCode, 200);
            assert.equal((await app.inject({ url: detail, headers: headers(session(otherWallet)) })).statusCode, 404);
            assert.deepEqual((await app.inject({ url: `/api/v1/stocks/${prefix}orders`, headers: headers(session(otherWallet)) })).json().data, []);
            assert.equal((await app.inject({ method: 'POST', url: `/api/v1/stocks/${prefix}orders`, headers: headers(session(otherWallet)), payload: { quoteId: quote.json().data.id, idempotencyKey: `foreign-${side}` } })).statusCode, 404);
        }
        const portfolio = await app.inject({ url: '/api/v1/stocks/portfolio', headers: headers() });
        assert.equal(portfolio.json().data.pending.length, 2);
        assert.deepEqual(fixture.calls.filter(call => call.actorId).map(call => call.actorId), Array(4).fill(`evm:${wallet}`));
        for (const kind of ['overview', 'orders', 'audit'])
            assert.equal((await app.inject({ url: `/api/v1/admin/stocks/${kind}`, headers: headers(session(operatorWallet)) })).statusCode, 200);
        const preflight = await app.inject({ method: 'OPTIONS', url: '/api/v1/stocks/quotes', headers: { origin: `https://${domain}`, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
        assert.equal(preflight.statusCode, 204);
        assert.equal(preflight.headers['access-control-allow-origin'], `https://${domain}`);
    } finally { await app.close(); }
});

test('buildApp Stocks rejects forged identities/roles and exposes no arbitrary settlement or admin mutation routes', async () => {
    const fixture = stocksBoundaryFixture();
    const services: ArcoAppServices & { stocks: StocksPluginOptions } = { ...legacyFixture().services, stocks: fixture.stocks };
    const app = buildApp(env, services);
    try {
        for (const route of ['quotes', 'sell-quotes', 'orders', 'sell-orders']) {
            for (const token of [null, session(wallet, { chainId: 1 }), session(wallet, { domain: 'foreign.test' }), session(wallet, { sub: 'invalid-wallet' })]) {
                const response = await app.inject({ method: 'POST', url: `/api/v1/stocks/${route}`, headers: token ? headers(token) : {}, payload: {} });
                assert.equal(response.statusCode, 401, `${route}: ${response.body}`);
            }
        }
        assert.equal((await app.inject({ method: 'POST', url: '/api/v1/stocks/quotes', headers: headers(), payload: { symbol: 'NVDA', quantity: '1', wallet: otherWallet } })).statusCode, 400);
        for (const requestHeaders of [
            { 'x-operator-token': env.adminOperatorToken, 'x-role': 'admin', 'x-wallet': operatorWallet },
            { ...headers(session(wallet, { role: 'admin', permissions: ['stocks:read'] })), 'x-operator-token': env.adminOperatorToken, 'x-role': 'admin' },
            headers(session(operatorWallet, { chainId: 1 })),
        ])
            assert.equal((await app.inject({ url: '/api/v1/admin/stocks/overview', headers: requestHeaders })).statusCode, 403);
        for (const url of [
            '/api/v1/stocks/funding', '/api/v1/stocks/confirm', '/api/v1/stocks/mint', '/api/v1/stocks/refund',
            '/api/v1/stocks/redeem', '/api/v1/stocks/return', '/api/v1/admin/stocks/orders', '/api/v1/admin/stocks/retry',
        ])
            assert.equal((await app.inject({ method: 'POST', url, headers: headers(session(operatorWallet)), payload: { wallet, amount: '999999' } })).statusCode, 404);
        assert.deepEqual(fixture.calls, [], 'Rejected requests must never enter the service boundary');
    } finally { await app.close(); }
});

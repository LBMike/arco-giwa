import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { FastifyRequest } from 'fastify';
import { a, testManifest } from '../stocks/test-fixtures.js';
import { stocksSessionResolvers, type NamedOperator } from './session.js';
import { createStocksRuntime, parseStocksRuntimeConfig } from './runtime.js';
import { checkStocksPreflight } from '../stocks-preflight/checker.js';

const { sign } = createRequire(import.meta.url)('jsonwebtoken') as typeof import('jsonwebtoken');
const secret = 'OPERATOR_DIRECTORY_TEST_ONLY';
const operator = () => ({ wallet: a(10), operatorId: 'reader', permissions: ['stocks:read'] });
const config = (operators: unknown) => ({ profile: 'DEMO_TESTNET', manifest: testManifest(),
  rpcUrl: 'https://rpc.example.test', signerUrl: 'https://signer.example.test',
  contractPolicyVerified: true, paused: true, operators });
const invalidDirectories: unknown[] = [undefined, null, {}, [null], [[]], [1], new Array(1),
  ...['', ' reader', 'reader ', 'a\n', 'a\u0000b', 'a\u0085b', '\ud800', '\udc00', 'a'.repeat(129), 1].map(operatorId => [{ ...operator(), operatorId }]),
  ...['bad-wallet', a(0), 12].map(wallet => [{ ...operator(), wallet }]),
  ...[null, 'stocks:read', {}, [null], ['stocks:admin'], ['stocks:read', 'stocks:read'], new Array(1)].map(permissions => [{ ...operator(), permissions }]),
  [operator(), { ...operator(), wallet: a(11) }],
  [operator(), { ...operator(), wallet: a(10).toUpperCase().replace('0X', '0x'), operatorId: 'other' }],
];

test('all operator configuration boundaries reject malformed identities and permissions with a fixed error', async () => {
  let effects = 0;
  const unexpected = async (): Promise<never> => { effects++; throw new Error('EXTERNAL_ACCESS'); };
  for (const operators of invalidDirectories) {
    const expected = { message: 'INVALID_STOCKS_OPERATORS', code: 'INVALID_STOCKS_OPERATORS' };
    assert.throws(() => parseStocksRuntimeConfig(config(operators)), expected);
    assert.throws(() => stocksSessionResolvers(secret, ['app.example.test'], operators as NamedOperator[]), expected);
    await assert.rejects(createStocksRuntime({ manifest: testManifest(), operators: operators as NamedOperator[],
      paused: true, autodispatch: false, pool: { query: unexpected, connect: unexpected, end: unexpected },
      transport: unexpected, signer: { probe: unexpected, lookup: unexpected, submit: unexpected } }), expected);
  }
  assert.equal(effects, 0, 'invalid operators must fail before RPC, signer, database or cleanup calls');
});

test('empty, read-only, control-only and no-permission directories remain valid without privilege expansion', async () => {
  assert.deepEqual(parseStocksRuntimeConfig(config([])).operators, []);
  const token = sign({ sub: a(10), chainId: 91342, domain: 'app.example.test' }, secret, { expiresIn: '15m' });
  const request = { headers: { authorization: `Bearer ${token}` } } as FastifyRequest;
  assert.equal(await stocksSessionResolvers(secret, ['app.example.test'], []).resolveOperator(request), null);
  for (const permissions of [[], ['stocks:read'], ['stocks:control'], ['stocks:read', 'stocks:control']]) {
    const operators = [{ ...operator(), operatorId: '운영자😀', permissions }];
    assert.deepEqual(parseStocksRuntimeConfig(config(operators)).operators, operators);
    assert.deepEqual(await stocksSessionResolvers(secret, ['app.example.test'], operators).resolveOperator(request), { operatorId: '운영자😀', permissions });
  }
  assert.equal(parseStocksRuntimeConfig(config([{ ...operator(), operatorId: 'a'.repeat(128) }])).operators[0].operatorId.length, 128);
  const upper = [{ ...operator(), wallet: a(10).toUpperCase().replace('0X', '0x') }];
  assert.equal(parseStocksRuntimeConfig(config(upper)).operators[0].wallet, a(10));
  assert.equal((await stocksSessionResolvers(secret, ['app.example.test'], upper).resolveOperator(request))?.operatorId, 'reader');
});

test('operator configuration and resolved permissions cannot be mutated across requests', async () => {
  const operators = [operator()];
  const parsed = parseStocksRuntimeConfig(config(operators));
  const resolvers = stocksSessionResolvers(secret, ['app.example.test'], operators);
  operators[0].permissions.push('stocks:control'); operators[0].operatorId = 'changed'; operators.push({ ...operator(), wallet: a(11) });
  assert.deepEqual(parsed.operators, [operator()]);
  const request = (wallet = a(10)) => ({ headers: { authorization: `Bearer ${sign({ sub: wallet, chainId: 91342, domain: 'app.example.test' }, secret, { expiresIn: '15m' })}` } }) as FastifyRequest;
  const first = await resolvers.resolveOperator(request());
  assert.deepEqual(first, { operatorId: 'reader', permissions: ['stocks:read'] });
  first!.permissions.push('stocks:control'); first!.operatorId = 'changed-result';
  assert.deepEqual(await resolvers.resolveOperator(request()), { operatorId: 'reader', permissions: ['stocks:read'] });
  assert.equal(await resolvers.resolveOperator(request(a(11))), null);
});

test('online preflight blocks invalid operator directories before constructing external probes', async () => {
  let probes = 0;
  for (const operators of invalidDirectories) {
    const report = await checkStocksPreflight({ STOCKS_MODE: 'DEMO_TESTNET', STOCKS_AUTODISPATCH: '1', STOCKS_CONFIG_PATH: '/public.json',
      STOCKS_SIGNER_TOKEN: 'TEST_ONLY', DATABASE_URL: 'postgresql://localhost/test' }, {
      online: true, readConfig: async () => config(operators), probes: () => { probes++; throw new Error('EXTERNAL_ACCESS'); },
    });
    assert.equal(report.status, 'BLOCKED');
    assert.equal(report.checks.find(check => check.id === 'configuration')?.status, 'FAIL');
  }
  assert.equal(probes, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import { PROFILE, StocksError, type Operator } from '../stocks/contracts.js';
import type { SubmissionDiagnosticsReader, SubmissionDiagnosticsSnapshot } from './contracts.js';
import { stocksSubmissionDiagnosticsPlugin } from './plugin.js';

const path = '/api/v1/admin/stocks/wallet-submissions';
const headers = { authorization: 'Bearer signed-operator-fixture' };
const named: Operator = { operatorId: 'named-reader', permissions: ['stocks:read'] };
function snapshot(side: 'BUY' | 'SELL' = 'BUY', id = 'order-1'): SubmissionDiagnosticsSnapshot {
  return {
    observedAt: '2026-09-17T00:00:00.000Z',
    data: {
      deploymentId: 'fixture-deployment', deploymentDigest: 'a'.repeat(64),
      order: { id, side, state: side === 'BUY' ? 'AWAITING_FUNDING' : 'AWAITING_ESCROW', wallet: `0x${'1'.repeat(40)}`, version: 0, quoteExpiresAt: '2026-09-17T00:10:00.000Z', quoteExpired: false },
      enrollment: 'ENROLLED', intentKey: 'b'.repeat(64), approval: null, transfer: null,
      readOnly: true, executionAuthorization: false, resubmissionAllowed: false,
    },
  };
}
function appWith(inspect: SubmissionDiagnosticsReader['inspect'] = async (side, id) => snapshot(side, id), resolveOperator: (request: FastifyRequest) => Promise<Operator | null> = async request => request.headers.authorization === headers.authorization ? named : null) {
  const app = Fastify();
  app.register(stocksSubmissionDiagnosticsPlugin, { service: { inspect }, resolveOperator });
  return app;
}
function error(response: { statusCode: number; headers: Record<string, unknown>; json(): unknown }, status: number, code: string) {
  assert.equal(response.statusCode, status);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json(), { error: code, ...PROFILE });
}
for (const side of ['BUY', 'SELL'] as const) test(`${side}: exact public response and database observedAt, one read and no permission`, async t => {
  const calls: unknown[] = [];
  const raw = snapshot(side); Object.assign(raw, { privateError: 'DO_NOT_LEAK' }); Object.assign(raw.data, { actorId: 'PRIVATE_ACTOR', rawEvidence: { secret: 'PRIVATE_PROOF' } });
  Object.defineProperty(raw.data, 'privateGetter', { enumerable: true, get() { throw new Error('PRIVATE_GETTER_MUST_NOT_RUN'); } });
  const app = appWith(async (requestedSide, id) => { calls.push([requestedSide, id]); return raw; }); t.after(() => app.close());
  const response = await app.inject({ url: `${path}/${side}/order-1`, headers });
  assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json(), { ...PROFILE, ...snapshot(side) }); assert.deepEqual(calls, [[side, 'order-1']]);
  assert.doesNotMatch(response.body, /PRIVATE|DO_NOT_LEAK/);
});
test('authentication precedes invalid side/id/query/body; shared tokens and browser roles grant nothing', async t => {
  let calls = 0; const app = appWith(async () => { calls++; return snapshot(); }); t.after(() => app.close());
  for (const request of [
    { url: `${path}/NO/order-1` }, { url: `${path}/BUY/invalid%20id` }, { url: `${path}/BUY/order-1?actorId=other` },
    { url: `${path}/BUY/order-1`, headers: { 'content-type': 'application/json' }, payload: '{broken' },
    { url: `${path}/BUY/order-1`, headers: { 'x-operator-token': 'legacy', 'x-role': 'admin' } },
    { url: `${path}/BUY/order-1`, headers: { authorization: 'Bearer browser-role' } },
  ]) error(await app.inject({ method: 'GET', ...request }), 403, 'OPERATOR_FORBIDDEN');
  assert.equal(calls, 0);
});
for (const [label, operator] of [
  ['null', null], ['unnamed', { permissions: ['stocks:read'] }], ['empty', { operatorId: '', permissions: ['stocks:read'] }],
  ['blank', { operatorId: '  ', permissions: ['stocks:read'] }], ['too long', { operatorId: 'x'.repeat(129), permissions: ['stocks:read'] }],
  ['no permission', { operatorId: 'named', permissions: [] }], ['string permissions', { operatorId: 'named', permissions: 'stocks:read' }],
] as const) test(`operator ${label} is rejected without reading service`, async t => {
  let calls = 0; const app = appWith(async () => { calls++; return snapshot(); }, async () => operator as Operator | null); t.after(() => app.close());
  error(await app.inject({ url: `${path}/BUY/order-1`, headers }), 403, 'OPERATOR_FORBIDDEN'); assert.equal(calls, 0);
});
test('absent resolver or thrown credential error always returns fixed403', async t => {
  const none = Fastify(); none.register(stocksSubmissionDiagnosticsPlugin, { service: { inspect: async () => { throw Error('MUST_NOT_READ'); } } }); t.after(() => none.close());
  error(await none.inject({ url: `${path}/BUY/order-1`, headers }), 403, 'OPERATOR_FORBIDDEN');
  const failed = appWith(undefined, async () => { throw new StocksError('SECRET_RESOLVER', 503); }); t.after(() => failed.close());
  error(await failed.inject({ url: `${path}/BUY/order-1`, headers }), 403, 'OPERATOR_FORBIDDEN');
});
test('authorized bad side, unsafe ID, query and body are fixed400 before service', async t => {
  let calls = 0; const app = appWith(async () => { calls++; return snapshot(); }); t.after(() => app.close());
  for (const url of [`${path}/buy/order-1`, `${path}/BUY/bad%20id`, `${path}/BUY/bad%2Fid`, `${path}/BUY/order-1?limit=1`, `${path}/BUY/order-1?__proto__[x]=1`]) error(await app.inject({ url, headers }), 400, 'INVALID_SUBMISSION_DIAGNOSTICS_INPUT');
  for (const request of [
    { payload: '{broken', headers: { ...headers, 'content-type': 'application/json' } },
    { payload: { side: 'SELL' }, headers },
    { payload: 'x', headers: { ...headers, 'transfer-encoding': 'chunked' } },
  ]) error(await app.inject({ method: 'GET', url: `${path}/BUY/order-1`, ...request }), 400, 'INVALID_SUBMISSION_DIAGNOSTICS_INPUT');
  assert.equal(calls, 0);
});
test('valid ID boundaries include100 characters, colons and underscore; empty body headers do not add a body', async t => {
  const calls: string[] = []; const app = appWith(async (side, id) => { calls.push(id); return snapshot(side, id); }); t.after(() => app.close());
  for (const id of ['a', 'a'.repeat(100), 'order:part_1-2']) {
    const response = await app.inject({ url: `${path}/BUY/${encodeURIComponent(id)}`, headers: { ...headers, 'content-length': '0' } });
    assert.equal(response.statusCode, 200); assert.equal(response.json().data.order.id, id); assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.deepEqual(calls, ['a', 'a'.repeat(100), 'order:part_1-2']);
});
test('only exact service ORDER_NOT_FOUND404 escapes; all other raw errors are fixed503', async t => {
  for (const [failure, status, code] of [
    [new StocksError('ORDER_NOT_FOUND', 404), 404, 'ORDER_NOT_FOUND'],
    [new StocksError('ORDER_NOT_FOUND', 400), 503, 'SUBMISSION_DIAGNOSTICS_UNAVAILABLE'],
    [new StocksError('OPERATOR_FORBIDDEN', 403), 503, 'SUBMISSION_DIAGNOSTICS_UNAVAILABLE'],
    [new StocksError('INVALID_SUBMISSION_DIAGNOSTICS_INPUT', 400), 503, 'SUBMISSION_DIAGNOSTICS_UNAVAILABLE'],
    [new Error('PRIVATE_SQL_URL'), 503, 'SUBMISSION_DIAGNOSTICS_UNAVAILABLE'],
    [Object.assign(new Error('PRIVATE'), { statusCode: 400 }), 503, 'SUBMISSION_DIAGNOSTICS_UNAVAILABLE'],
    [{ code: 'ORDER_NOT_FOUND', status: 404 }, 503, 'SUBMISSION_DIAGNOSTICS_UNAVAILABLE'],
  ] as const) {
    const app = appWith(async () => { throw failure; }); t.after(() => app.close());
    error(await app.inject({ url: `${path}/BUY/order-1`, headers }), status, code);
  }
});
test('invalid public data and mismatched valid scope fail503 rather than disclose another order', async t => {
  for (const invalid of [null, { ...snapshot(), observedAt: 'invalid' }, { ...snapshot(), data: { ...snapshot().data, executionAuthorization: true } }, snapshot('SELL'), snapshot('BUY', 'other-order')]) {
    const app = appWith(async () => invalid as SubmissionDiagnosticsSnapshot); t.after(() => app.close());
    error(await app.inject({ url: `${path}/BUY/order-1`, headers }), 503, 'SUBMISSION_DIAGNOSTICS_UNAVAILABLE');
  }
});
test('no implicit HEAD or mutation routes and no journal reads for other methods', async t => {
  let calls = 0; const app = appWith(async () => { calls++; return snapshot(); }); t.after(() => app.close());
  for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    const response = await app.inject({ method, url: `${path}/BUY/order-1`, headers }); assert.equal(response.statusCode, 404);
  }
  assert.equal(calls, 0);
});

test('101-character IDs are rejected by the default router414, not a matched-route input response', async t => {
  let calls = 0, resolutions = 0
  const app = appWith(async () => { calls++; return snapshot(); }, async () => { resolutions++; return named; }); t.after(() => app.close());
  const r = await app.inject({ url: `${path}/BUY/${'a'.repeat(101)}`, headers });
  assert.equal(r.statusCode, 414); assert.equal(r.json().code, 'FST_ERR_MAX_PARAM_LENGTH'); assert.equal(calls, 0); assert.equal(resolutions, 0);
});

test('an empty raw query delimiter is rejected before the reader', async t => {
  let calls = 0
  const app = Fastify()
  // light-my-request normalizes a trailing ? away. Restore only that raw marker before the plugin hook.
  app.addHook('onRequest', async request => { request.raw.url += '?' })
  app.register(stocksSubmissionDiagnosticsPlugin, { service: { inspect: async () => { calls++; return snapshot() } }, resolveOperator: async () => named })
  t.after(() => app.close())
  error(await app.inject({url:`${path}/BUY/order-1`,headers}),400,'INVALID_SUBMISSION_DIAGNOSTICS_INPUT')
  assert.equal(calls,0)
})

test('trusted receipt summary is public but nested evidence and actor metadata are not', async t => {
  const raw = snapshot();
  raw.data.transfer = {
    claimId: 'claim-1', intentKey: raw.data.intentKey, stage: 'TRANSFER', transactionDigest: 'c'.repeat(64), status: 'CONFIRMED',
    txHash: `0x${'d'.repeat(64)}`, createdAt: '2026-09-16T23:58:00.000Z', updatedAt: '2026-09-16T23:59:00.000Z',
    receipt: { status: 'CONFIRMED', blockNumber: '123', blockHash: `0x${'e'.repeat(64)}`, verifiedAt: '2026-09-16T23:59:00.000Z' },
  };
  Object.assign(raw.data.transfer, { actorId: 'PRIVATE_ACTOR', transaction: { data: 'PRIVATE_CALLDATA' } });
  Object.assign(raw.data.transfer.receipt!, { evidence: { proof: 'PRIVATE_PROOF' } });
  const app = appWith(async () => raw); t.after(() => app.close());
  const response = await app.inject({ url: `${path}/BUY/order-1`, headers });
  assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.json().data.order.state, 'AWAITING_FUNDING');
  assert.deepEqual(Object.keys(response.json().data.transfer.receipt).sort(), ['status','blockNumber','blockHash','verifiedAt'].sort());
  assert.equal(response.json().data.executionAuthorization, false); assert.equal(response.json().data.resubmissionAllowed, false);
  assert.doesNotMatch(response.body, /PRIVATE|actorId|transaction"|evidence/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createLocalBrowserHost } from './browser-server.mjs';

const repository = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const A = `0x${'1'.repeat(40)}`, B = `0x${'2'.repeat(40)}`;
async function fixture(t, recovery = false, operatorDiagnostics = false, ownerWorkspace = false) {
  const previousFlag = process.env.STOCKS_LOCAL_STACK_ONLY;
  process.env.STOCKS_LOCAL_STACK_ONLY = '1';
  const directory = await mkdtemp(join(tmpdir(), 'stocks-browser-unit-'));
  let host;
  t.after(async () => {
    try { await host?.close(); } finally {
      await rm(directory, { recursive: true, force: true });
      if (previousFlag === undefined) delete process.env.STOCKS_LOCAL_STACK_ONLY;
      else process.env.STOCKS_LOCAL_STACK_ONLY = previousFlag;
    }
  });
  const root = join(directory, 'root'); await mkdir(root);
  await symlink(join(repository, 'node_modules'), join(root, 'node_modules'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>LOCAL TEST</title>');
  await mkdir(join(root, 'scripts/stocks-local/browser'), { recursive: true });
  await writeFile(join(root, 'scripts/stocks-local/browser/index.html'), '<!doctype html><title>STOCKS ENTRY</title>');
  const sigtermOwners = process.listeners('SIGTERM');
  host = await createLocalBrowserHost({ root, resourceDir: directory, ownerWorkspace });
  assert.deepEqual(process.listeners('SIGTERM'), sigtermOwners, 'Browser host must not install a Vite process.exit signal handler');
  let account = A, closed = false, hold, nextHold = false;
  const calls = [], sends = [], controls = [];
  const wallet = {
    get account() { return account; }, get calls() { return calls; }, get sends() { return sends; },
    setAccount(value) { assert.ok(!closed); account = value; },
    holdNextSend() {
      nextHold = true; let arrive, release, reject;
      const arrived = new Promise(resolve => { arrive = resolve; });
      const wait = new Promise((resolve, no) => { release = resolve; reject = no; }); void wait.catch(() => {});
      hold = { arrived, arrive, wait, release, drop: () => reject(new Error('PRIVATE_FAKE_ERROR')) }; return hold;
    },
    provider: { async request(input) {
      assert.ok(!closed); calls.push(input.method);
      if (input.method === 'personal_sign') throw new Error('TOKEN_SIGNATURE_SHOULD_NEVER_ESCAPE');
      if (input.method === 'eth_accounts') return [account];
      if (input.method === 'eth_sendTransaction') {
        const transaction = input.params[0];
        if (transaction.from !== account) throw new Error('PRIVATE_FROM_MISMATCH');
        const send = { hash: `0x${'3'.repeat(64)}`, outcome: 'PENDING' }; sends.push(send);
        if (nextHold) { nextHold = false; hold.arrive({ hash: send.hash }); await hold.wait; }
        if (closed) throw new Error('PRIVATE_CLOSED'); send.outcome = 'RETURNED'; return send.hash;
      }
      return '0x164ce';
    } },
    close() { closed = true; hold?.drop(); },
  };
  const stack = { apiBase: 'http://127.0.0.1:12345', frontendOrigin: host.origin, accounts: { holder: A, otherHolder: B, operator: `0x${'4'.repeat(40)}` }, manifest: { fixture: true },
    operatorDiagnostics,
    armShortSession: recovery ? () => controls.push('short-session') : undefined,
    async topUpTestCash() { controls.push('test-cash'); },
    async snapshot() { return { buyOrders: [], sellOrders: [], claims: [], proofs: [], chain: { holderStock: '0', holderCash: '2' } }; },
    async stopProcessing() { controls.push('stop'); }, async startProcessing() { controls.push('start'); }, async restartApi() { controls.push('restart'); },
  };
  const config = host.attach({ stack, wallet });
  const headers = { origin: host.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-stocks-local-capability': config.capability };
  const post = (path, value, overrides = {}) => fetch(host.origin + path, { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(value) });
  const state = async () => (await fetch(host.origin + '/__local/state', { headers: { 'sec-fetch-site': 'same-origin', 'x-stocks-local-capability': config.capability } })).json();
  return { host, config, headers, post, state, calls, sends, controls };
}

test('bootstrap and all static assets reject foreign Host; config has same-origin gate and no CORS/cache', async t => {
  const f = await fixture(t);
  for (const headers of [{}, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-origin', origin: 'http://evil.test' }])
    assert.equal((await fetch(f.host.origin + '/__local/config', { headers })).status, 403);
  const response = await fetch(f.host.origin + '/__local/config', { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal((await response.json()).capability, f.config.capability);
  const asset = await new Promise((resolve, reject) => {
    const req = httpRequest(f.host.origin + '/index.html', { headers: { Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(asset, 403);
  const reload = await fetch(f.host.origin + '/stocks/NVDA', { headers: { accept: 'text/html' } });
  assert.equal(reload.status, 200); assert.match(await reload.text(), /STOCKS ENTRY/);
  assert.equal((await fetch(f.host.origin + '/not-stocks', { headers: { accept: 'text/html' } })).status, 404);
});

test('two browser hosts own separate update connections and reject foreign origins and tokens', async t => {
  const first = await fixture(t), second = await fixture(t);
  const token = async fixture => {
    const client = await fetch(fixture.host.origin + '/@vite/client').then(response => response.text());
    const match = client.match(/const wsToken = ("[^"\n]+");/);
    assert.ok(match, 'Vite serves a token for this host');
    return JSON.parse(match[1]);
  };
  const firstToken = await token(first), secondToken = await token(second);
  const connect = (fixture, value, origin = fixture.host.origin) => new Promise((resolve, reject) => {
    const request = httpRequest(fixture.host.origin + '/?token=' + encodeURIComponent(value), {
      headers: { connection: 'Upgrade', upgrade: 'websocket', origin,
        'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-protocol': 'vite-hmr' },
    });
    const timer = setTimeout(() => request.destroy(new Error('Owned update handshake timed out')), 3000);
    request.once('upgrade', (_response, socket) => { clearTimeout(timer); t.after(() => socket.destroy()); resolve(socket); });
    request.once('error', error => { clearTimeout(timer); reject(error); });
    request.once('response', response => { clearTimeout(timer); response.resume(); reject(new Error('Update handshake rejected')); });
    request.end();
  });
  const firstSocket = await connect(first, firstToken), secondSocket = await connect(second, secondToken);
  firstSocket.resume(); secondSocket.resume();
  await assert.rejects(connect(first, firstToken, 'http://foreign.test'));
  await assert.rejects(connect(first, secondToken));
  const closed = new Promise(resolve => firstSocket.once('close', resolve));
  await first.host.close(); await closed;
  assert.equal(secondSocket.destroyed, false, 'Closing one workspace keeps the other connection alive');
  assert.equal((await fetch(second.host.origin + '/__local/config', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
});

test('cash top-up is owner-only and rejects altered targets and unauthorized requests before invoking the faucet', async t => {
  const originalFlag = process.env.STOCKS_LOCAL_STACK_ONLY;
  const disabled = await fixture(t);
  assert.equal((await disabled.post('/__local/control', { action: 'topUpTestCash' })).status, 403);
  assert.deepEqual(disabled.controls, []);
  const enabled = await fixture(t, false, false, true);
  t.after(() => { if (originalFlag === undefined) delete process.env.STOCKS_LOCAL_STACK_ONLY; else process.env.STOCKS_LOCAL_STACK_ONLY = originalFlag; });
  for (const extra of [{ amount: '1000000' }, { account: 'B' }, { to: B }])
    assert.equal((await enabled.post('/__local/control', { action: 'topUpTestCash', ...extra })).status, 400);
  for (const headers of [{ origin: 'http://foreign.test' }, { 'x-stocks-local-capability': '' }])
    assert.equal((await enabled.post('/__local/control', { action: 'topUpTestCash' }, headers)).status, 403);
  assert.deepEqual(enabled.controls, []);
  assert.equal((await enabled.post('/__local/control', { action: 'topUpTestCash' })).status, 200);
  assert.deepEqual(enabled.controls, ['test-cash']);
});

test('short-session control is absent by default and available only in the explicit recovery fixture', async t => {
  const originalFlag = process.env.STOCKS_LOCAL_STACK_ONLY;
  const disabled = await fixture(t);
  assert.equal(disabled.config.knownHashRecovery, false);
  assert.equal((await disabled.post('/__local/control', { action: 'armShortSession' })).status, 403);
  assert.deepEqual(disabled.controls, []);
  const enabled = await fixture(t, true);
  // Both fixture cleanups run before this final restoration.
  t.after(() => { if (originalFlag === undefined) delete process.env.STOCKS_LOCAL_STACK_ONLY; else process.env.STOCKS_LOCAL_STACK_ONLY = originalFlag; });
  assert.equal(enabled.config.knownHashRecovery, true);
  assert.equal((await enabled.post('/__local/control', { action: 'armShortSession', seconds: 900 })).status, 400);
  assert.equal((await enabled.post('/__local/control', { action: 'armShortSession' }, { origin: 'http://foreign.test' })).status, 403);
  assert.deepEqual(enabled.controls, []);
  assert.equal((await enabled.post('/__local/control', { action: 'armShortSession' })).status, 200);
  assert.deepEqual(enabled.controls, ['short-session']);
});

test('wallet/control require exact origin, fetch site, JSON and capability before invoking ports', async t => {
  const f = await fixture(t), input = { method: 'eth_accounts', params: [] };
  for (const overrides of [
    { origin: 'http://evil.test' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': '' },
    { 'x-stocks-local-capability': '' }, { 'x-stocks-local-capability': 'a'.repeat(64) },
    { 'content-type': 'text/plain' },
  ]) assert.ok([403, 415].includes((await f.post('/__local/wallet', input, overrides)).status));
  assert.equal((await f.post('/__local/wallet', { ...input, extra: true })).status, 400);
  assert.equal((await f.post('/__local/wallet', { method: 'hardhat_reset', params: [] })).status, 400);
  assert.equal((await f.post('/__local/control', { action: 'setOrderState', state: 'COMPLETED' })).status, 400);
  assert.equal((await f.post('/__local/wallet', { method: 'eth_accounts', params: [], padding: 'x'.repeat(17000) })).status, 413);
  const malformed = await fetch(f.host.origin + '/__local/wallet', { method: 'POST', headers: f.headers, body: '{' });
  assert.equal(malformed.status, 400); assert.equal(f.calls.length, 0);
  assert.deepEqual(await (await f.post('/__local/wallet', input)).json(), { result: [A] });
  const failed = await f.post('/__local/wallet', { method: 'personal_sign', params: ['SECRET', A] });
  const error = await failed.text(); assert.equal(failed.status, 502);
  assert.ok(!error.includes('TOKEN_SIGNATURE') && !error.includes('SECRET'));
});

test('narrow controls track accepted held response, account switch, state redaction and resume', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/__local/control', { action: 'holdNextSend' })).status, 200);
  assert.equal((await f.state()).holdArmed, true);
  const send = f.post('/__local/wallet', { method: 'eth_sendTransaction', params: [{ from: A }] });
  for (let i = 0; i < 50 && !(await f.state()).holdWaiting; i++) await delay(10);
  const held = await f.state(); assert.equal(held.holdWaiting, true); assert.equal(held.holdArmed, false);
  assert.deepEqual(held.sends, [{ outcome: 'PENDING' }]);
  assert.equal((await f.post('/__local/control', { action: 'account', account: 'B' })).status, 200);
  assert.equal((await f.state()).account, B);
  assert.equal((await f.post('/__local/control', { action: 'releaseHeld' })).status, 200);
  assert.equal((await send).status, 200);
  assert.equal((await f.post('/__local/wallet', { method: 'eth_sendTransaction', params: [{ from: A }] })).status, 502);
  assert.equal(f.sends.length, 1);
  for (const action of ['stopProcessing', 'startProcessing', 'restartApi']) assert.equal((await f.post('/__local/control', { action })).status, 200);
  assert.deepEqual(f.controls, ['stop', 'start', 'restart']);
  assert.equal((await f.post('/__local/finish', { ok: true, token: 'no' })).status, 400);
  assert.equal((await f.post('/__local/finish', { ok: true })).status, 200);
  assert.deepEqual(await f.host.finished, { ok: true });
  assert.equal((await f.post('/__local/finish', { ok: true })).status, 409);
});

test('closing releases held wallet HTTP and is idempotent', async t => {
  const f = await fixture(t);
  await f.post('/__local/control', { action: 'holdNextSend' });
  const pending = f.post('/__local/wallet', { method: 'eth_sendTransaction', params: [{ from: A }] });
  for (let i = 0; i < 50 && !(await f.state()).holdWaiting; i++) await delay(10);
  assert.equal((await f.state()).holdWaiting, true);
  const closing = f.host.close(); assert.equal(f.host.close(), closing);
  const response = await pending; assert.equal(response.status, 502); await closing;
  assert.deepEqual(await f.host.finished, { ok: false, error: 'LOCAL_HOST_CLOSED' });
});

test('READY is rechecked after streaming body; close prevents a late wallet invocation', async t => {
  const f = await fixture(t);
  let request;
  const response = new Promise((resolve, reject) => {
    request = httpRequest(f.host.origin + '/__local/wallet', { method: 'POST', headers: f.headers }, res => { res.resume(); resolve(res.statusCode); });
    request.on('error', reject); request.write('{"method":"eth_accounts",');
  });
  await delay(30);
  const closing = f.host.close(); request.end('"params":[]}');
  assert.equal(await response, 503); await closing; assert.equal(f.calls.length, 0);
});
test('operator account control is opt-in and still requires capability, same-origin and exact body', async t => {
  const originalFlag = process.env.STOCKS_LOCAL_STACK_ONLY;
  const disabled = await fixture(t);
  assert.equal(disabled.config.operatorDiagnostics, false);
  assert.equal(disabled.config.accounts.operator, undefined);
  assert.equal((await disabled.post('/__local/control', { action: 'account', account: 'operator' })).status, 400);
  const enabled = await fixture(t, false, true);
  t.after(() => { if (originalFlag === undefined) delete process.env.STOCKS_LOCAL_STACK_ONLY; else process.env.STOCKS_LOCAL_STACK_ONLY = originalFlag; });
  assert.equal(enabled.config.operatorDiagnostics, true);
  const input = { action: 'account', account: 'operator' };
  assert.equal((await enabled.post('/__local/control', input, { 'x-stocks-local-capability': '' })).status, 403);
  assert.equal((await enabled.post('/__local/control', input, { origin: 'http://foreign.test' })).status, 403);
  assert.equal((await enabled.post('/__local/control', { ...input, permission: 'write' })).status, 400);
  assert.equal((await enabled.state()).account, A);
  assert.equal((await enabled.post('/__local/control', input)).status, 200);
  assert.equal((await enabled.state()).account, enabled.config.accounts.operator);
  assert.deepEqual(enabled.calls, []); assert.deepEqual(enabled.sends, []);
});

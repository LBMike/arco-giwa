// Disposable browser verification host. Never import the product Vite config/env.
import assert from 'node:assert/strict';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createServer } from 'vite';
import { createServer as createHttpServer } from 'node:http';
import react from '@vitejs/plugin-react';

const BODY_LIMIT = 16 * 1024;
const WALLET_METHODS = new Set(['eth_accounts', 'eth_chainId', 'eth_getBlockByNumber', 'eth_call', 'personal_sign', 'eth_sendTransaction']);
const failure = (status, code) => Object.assign(new Error(code), { status, code });
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function bounded(promise, milliseconds) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(failure(503, 'LOCAL_HOST_CLOSE_TIMEOUT')), milliseconds); })])
    .finally(() => clearTimeout(timer));
}
function body(request) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], done = false;
    const finish = (error, value) => {
      if (done) return; done = true;
      request.off('data', data); request.off('end', end); request.off('error', failed); request.off('aborted', aborted);
      if (error) { request.resume(); reject(error); } else resolve(value);
    };
    const data = chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) finish(failure(413, 'LOCAL_BODY_TOO_LARGE'));
      else chunks.push(chunk);
    };
    const end = () => {
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(failure(400, 'LOCAL_BODY_INVALID')); }
      chunks = [];
    };
    const failed = () => finish(failure(400, 'LOCAL_BODY_INVALID'));
    const aborted = () => finish(failure(400, 'LOCAL_BODY_INVALID'));
    request.on('data', data); request.on('end', end); request.on('error', failed); request.on('aborted', aborted);
  });
}

export async function createLocalBrowserHost({ root, resourceDir, ownerWorkspace = false }) {
  assert.equal(process.env.STOCKS_LOCAL_STACK_ONLY, '1');
  assert.equal(typeof ownerWorkspace, 'boolean');
  assert.ok(isAbsolute(root) && isAbsolute(resourceDir));
  const resources = await mkdtemp(join(resourceDir, 'browser-host-'));
  const envDir = join(resources, 'empty-env'), cacheDir = join(resources, 'cache');
  try { await mkdir(envDir); await mkdir(cacheDir); }
  catch (error) { await rm(resources, { recursive: true, force: true }); throw error; }
  const capability = randomBytes(32).toString('hex');
  const pending = new Set();
  let phase = 'STARTING', vite, httpServer, origin, host, stack, wallet, held, closing, finishSignal;
  let finishResult, resolveFinished;
  const finished = new Promise(resolve => { resolveFinished = resolve; });
  const requireReady = () => { if (phase !== 'READY') throw failure(503, 'LOCAL_HOST_UNAVAILABLE'); };
  function json(response, status, value) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' });
    response.end(JSON.stringify(value));
  }
  function guard(request, protectedRoute) {
    if (request.headers.host !== host) throw failure(403, 'LOCAL_HOST_FORBIDDEN');
    if (request.headers['sec-fetch-site'] !== 'same-origin') throw failure(403, 'LOCAL_ORIGIN_FORBIDDEN');
    const suppliedOrigin = request.headers.origin;
    if ((request.method === 'POST' || suppliedOrigin !== undefined) && suppliedOrigin !== origin)
      throw failure(403, 'LOCAL_ORIGIN_FORBIDDEN');
    if (protectedRoute) {
      const supplied = request.headers['x-stocks-local-capability'];
      if (typeof supplied !== 'string' || !/^[0-9a-f]{64}$/.test(supplied)
        || !timingSafeEqual(Buffer.from(supplied), Buffer.from(capability))) throw failure(403, 'LOCAL_CAPABILITY_FORBIDDEN');
    }
    if (request.method === 'POST' && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? ''))
      throw failure(415, 'LOCAL_JSON_REQUIRED');
  }
  const config = () => ({ apiBase: stack.apiBase, frontendOrigin: origin, ownerWorkspace,
    knownHashRecovery: typeof stack.armShortSession === 'function',
    accounts: { holder: stack.accounts.holder, otherHolder: stack.accounts.otherHolder,
      ...(stack.operatorDiagnostics ? { operator: stack.accounts.operator } : {}) }, account: wallet.account,
    operatorDiagnostics: stack.operatorDiagnostics === true,
    manifest: structuredClone(stack.manifest), capability });
  async function state() {
    requireReady();
    const snapshot = await stack.snapshot();
    requireReady();
    return { account: wallet.account, holdArmed: !!held && !held.waiting, holdWaiting: !!held?.waiting,
      calls: wallet.calls.length, sends: wallet.sends.map(({ outcome }) => ({ outcome })),
      snapshot: { buyOrders: snapshot.buyOrders.map(({ id, state }) => ({ id, state })),
        sellOrders: snapshot.sellOrders.map(({ id, state }) => ({ id, state })), claimCount: snapshot.claims.length,
        proofCount: snapshot.proofs.length, ...snapshot.chain,
        reconciliationStatus: snapshot.reconciliation?.status ?? 'UNAVAILABLE' } };
  }
  async function control(input) {
    if (!input || typeof input.action !== 'string') throw failure(400, 'LOCAL_CONTROL_INVALID');
    if (input.action === 'account') {
      if (!exact(input, ['action', 'account']) || !['A', 'B', ...(stack.operatorDiagnostics ? ['operator'] : [])].includes(input.account)) throw failure(400, 'LOCAL_CONTROL_INVALID');
      wallet.setAccount(input.account === 'A' ? stack.accounts.holder : input.account === 'B' ? stack.accounts.otherHolder : stack.accounts.operator);
      return;
    }
    if (!exact(input, ['action'])) throw failure(400, 'LOCAL_CONTROL_INVALID');
    switch (input.action) {
      case 'holdNextSend': {
        if (held) throw failure(409, 'LOCAL_HOLD_EXISTS');
        const hold = { ...wallet.holdNextSend(), waiting: false }; held = hold;
        void hold.arrived.then(value => {
          if (held === hold) { if (value?.hash) hold.waiting = true; else held = undefined; }
        }, () => { if (held === hold) held = undefined; });
        return;
      }
      case 'releaseHeld': case 'dropHeld': {
        if (!held?.waiting) throw failure(409, 'LOCAL_HOLD_NOT_WAITING');
        const hold = held; held = undefined;
        if (input.action === 'releaseHeld') hold.release(); else hold.drop();
        return;
      }
      case 'stopProcessing': await stack.stopProcessing(); return;
      case 'startProcessing': await stack.startProcessing(); return;
      case 'restartApi': await stack.restartApi(); return;
      case 'topUpTestCash':
        if (!ownerWorkspace || typeof stack.topUpTestCash !== 'function') throw failure(403, 'LOCAL_TEST_CASH_DISABLED');
        await stack.topUpTestCash(); return;
      case 'armShortSession':
        if (typeof stack.armShortSession !== 'function') throw failure(403, 'LOCAL_RECOVERY_FIXTURE_DISABLED');
        stack.armShortSession(); return;
      default: throw failure(400, 'LOCAL_CONTROL_INVALID');
    }
  }
  async function handle(request, response) {
    const path = request.url;
    try {
      const isConfig = path === '/__local/config' && request.method === 'GET';
      guard(request, !isConfig); requireReady();
      if (isConfig) return json(response, 200, config());
      if (path === '/__local/state' && request.method === 'GET') return json(response, 200, await state());
      if (request.method !== 'POST' || !['/__local/wallet', '/__local/control', '/__local/finish'].includes(path))
        throw failure(404, 'LOCAL_ROUTE_NOT_FOUND');
      const input = await body(request);
      // Shutdown can begin while a client is still streaming its request.
      requireReady();
      if (path === '/__local/wallet') {
        if (!exact(input, ['method', 'params']) || typeof input.method !== 'string' || !Array.isArray(input.params)
          || !WALLET_METHODS.has(input.method)) throw failure(400, 'LOCAL_WALLET_METHOD_DENIED');
        const result = await wallet.provider.request({ method: input.method, params: input.params });
        requireReady(); return json(response, 200, { result });
      }
      if (path === '/__local/control') { await control(input); requireReady(); return json(response, 200, { ok: true }); }
      if ((!exact(input, ['ok']) && !exact(input, ['ok', 'error'])) || typeof input.ok !== 'boolean'
        || (input.error !== undefined && (typeof input.error !== 'string' || !/^[A-Z0-9_:-]{1,96}$/.test(input.error))))
        throw failure(400, 'LOCAL_FINISH_INVALID');
      if (finishResult) throw failure(409, 'LOCAL_ALREADY_FINISHED');
      finishResult = Object.freeze({ ...input });
      json(response, 200, { ok: true }); resolveFinished(finishResult); finishSignal?.(finishResult);
    } catch (error) {
      const known = Number.isInteger(error?.status) && typeof error?.code === 'string' && /^LOCAL_[A-Z_]+$/.test(error.code);
      json(response, known ? error.status : 502, { error: { code: known ? error.code : -32603,
        message: known ? error.code : 'LOCAL_WALLET_REQUEST_FAILED' } });
    }
  }
  function close() {
    if (closing) return closing;
    phase = 'CLOSING';
    closing = (async () => {
      const failures = [];
      try { wallet?.close(); } catch (error) { failures.push(error); }
      held = undefined;
      try { await bounded(Promise.allSettled([...pending]), 1000); } catch { /* force-close stalled clients below */ }
      // The executable alone owns process signals. Collect both independent
      // closers even if one fails; no Vite process.exit handler is installed.
      const stopped = await Promise.allSettled([
        (async () => {
          if (!httpServer) return;
          httpServer.closeAllConnections();
          await bounded(new Promise((resolve, reject) => httpServer.close(error => {
            if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve();
          })), 5000);
        })(),
        (async () => { if (vite) await bounded(vite.close(), 5000); })(),
      ]);
      for (const result of stopped) if (result.status === 'rejected') failures.push(result.reason);
      try { await rm(resources, { recursive: true, force: true }); } catch (error) { failures.push(error); }
      phase = 'CLOSED';
      if (!finishResult) resolveFinished({ ok: false, error: 'LOCAL_HOST_CLOSED' });
      if (failures.length) throw new AggregateError(failures, 'LOCAL_HOST_CLOSE_FAILED');
    })();
    return closing;
  }
  try {
    const dependencyDir = await realpath(join(root, 'node_modules'));
    // Vite 5 still opens its default WebSocket listener with hmr:false. Two
    // workspaces then share port 24678 and the client can enter a reload loop.
    // Put HTTP and development updates on this workspace's owned listener.
    httpServer = createHttpServer();
    httpServer.on('upgrade', (request, socket) => {
      if (!host || request.headers.host !== host || request.headers.origin !== origin || phase === 'CLOSING' || phase === 'CLOSED')
        socket.destroy();
    });
    vite = await createServer({ root, configFile: false, envDir, envPrefix: 'STOCKS_LOCAL_BROWSER_UNUSED_', cacheDir,
      appType: 'mpa', logLevel: 'silent', clearScreen: false, plugins: [
        { name: 'stocks-local-browser-boundary', configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (!host || request.headers.host !== host) return json(response, 403, { error: { code: 'LOCAL_HOST_FORBIDDEN', message: 'LOCAL_HOST_FORBIDDEN' } });
            if (!request.url?.startsWith('/__local/')) {
              // Only the mounted Stocks test routes receive this entry on reload.
              const path = request.url?.split('?')[0];
              if (['GET', 'HEAD'].includes(request.method) && /(?:^|[,;\s])text\/html(?:$|[,;\s])/.test(request.headers.accept ?? '')
                && /^(?:\/stocks(?:\/NVDA)?|\/admin\/stocks(?:\/[A-Za-z0-9_-]+)?)\/?$/.test(path ?? ''))
                request.url = '/scripts/stocks-local/browser/index.html';
              return next();
            }
            const work = handle(request, response); pending.add(work); void work.finally(() => pending.delete(work));
          });
        } }, react(),
      ], resolve: { alias: { '@': join(root, 'src') } },
      server: { middlewareMode: true, host: '127.0.0.1', port: 0, strictPort: true, cors: false,
        hmr: { server: httpServer },
        fs: { strict: true, allow: [root, dependencyDir], deny: ['.env', '.env.*', '**/.git/**', '**/.secrets/**', '*.{crt,pem,key}'] } },
    });
    // Middleware mode awaits Vite's initialization in createServer and avoids
    // its standalone SIGTERM/process.exit handler. Own the loopback listener.
    httpServer.on('request', vite.middlewares);
    await new Promise((resolve, reject) => {
      const server = httpServer;
      const failed = error => { server.off('listening', ready); reject(error); };
      const ready = () => { server.off('error', failed); resolve(); };
      server.once('error', failed); server.once('listening', ready); server.listen(0, '127.0.0.1');
    });
    host = `127.0.0.1:${httpServer.address().port}`; origin = `http://${host}`; phase = 'UNATTACHED';
    return { origin, url: `${origin}/scripts/stocks-local/browser/index.html`, finished,
      attach(input) {
        assert.equal(phase, 'UNATTACHED');
        assert.equal(input.stack.frontendOrigin, origin);
        assert.ok(input.wallet?.provider && typeof input.wallet.close === 'function');
        stack = input.stack; wallet = input.wallet; finishSignal = input.finishSignal; phase = 'READY';
        return config();
      }, close, state };
  } catch (error) { await close().catch(() => {}); throw error; }
}

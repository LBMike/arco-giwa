import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const launcher = fileURLToPath(new URL('./serve.mjs', import.meta.url));
const marketPath = '/api/v1/stocks/market/catalog';
const environmentId = '11111111-1111-4111-8111-111111111111';

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    const failed = error => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', failed); resolve(); };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen(port, '127.0.0.1');
  });
}

async function close(server) {
  if (!server.listening) return;
  const force = setTimeout(() => server.closeAllConnections(), 3_000);
  force.unref?.();
  try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  finally { clearTimeout(force); }
}

async function unusedPort() {
  const probe = createServer();
  await listen(probe, 0);
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await close(probe);
  return address.port;
}

function startPreview(port, marketPort, temporaryRoot) {
  const child = spawn(process.execPath, [
    '--import', 'tsx', launcher,
    '--port', String(port),
    '--dynamic-environment', environmentId,
    '--market-api', `http://127.0.0.1:${marketPort}`,
  ], { cwd: root, env: { ...process.env, TMPDIR: temporaryRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const capture = chunk => { output = (output + chunk.toString()).slice(-8_000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited, output: () => output };
}

async function waitForPreview(preview, port) {
  const marker = `Product preview: http://127.0.0.1:${port}`;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Preview startup timed out: ${preview.output()}`)), 30_000);
    const changed = () => { if (preview.output().includes(marker)) finish(); };
    const exited = (code, signal) => finish(new Error(`Preview exited before startup (${code ?? signal}): ${preview.output()}`));
    const failed = error => finish(error);
    const finish = error => {
      clearTimeout(timer);
      preview.child.stdout.off('data', changed);
      preview.child.stderr.off('data', changed);
      preview.child.off('exit', exited);
      preview.child.off('error', failed);
      if (error) reject(error); else resolve();
    };
    preview.child.stdout.on('data', changed);
    preview.child.stderr.on('data', changed);
    preview.child.once('exit', exited);
    preview.child.once('error', failed);
    if (preview.child.exitCode !== null || preview.child.signalCode !== null) exited(preview.child.exitCode, preview.child.signalCode);
    else changed();
  });
}

async function stopPreview(preview) {
  if (preview.child.exitCode !== null || preview.child.signalCode !== null) return;
  preview.child.kill('SIGTERM');
  const force = setTimeout(() => preview.child.kill('SIGKILL'), 5_000);
  force.unref?.();
  try { await preview.exited; }
  finally { clearTimeout(force); }
}

test('the running preview reports market outage, recovery, and outage without restart or synthetic prices', { timeout: 60_000 }, async () => {
  const previewPort = await unusedPort();
  let marketPort;
  do { marketPort = await unusedPort(); } while (marketPort === previewPort);
  const origin = `http://127.0.0.1:${previewPort}`;
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'arco-product-preview-test-'));
  const preview = startPreview(previewPort, marketPort, temporaryRoot);
  let market;
  try {
    await waitForPreview(preview, previewPort);
    const read = () => fetch(`${origin}${marketPath}`, { signal: AbortSignal.timeout(5_000), cache: 'no-store' });
    const unavailable = await read();
    assert.equal(unavailable.status, 502);
    assert.deepEqual(await unavailable.json(), { error: 'PUBLIC_DATA_UNAVAILABLE' });

    const liveCatalog = {
      schemaVersion: 1, profile: 'DEMO_TESTNET', chainId: 91342, purpose: 'DISPLAY_ONLY',
      priceBasis: 'UNDERLYING_SECURITY', executionPriceSource: 'FIXED_MOCK_PRICE',
      provider: 'ALPACA', marketFeed: 'IEX', status: 'AVAILABLE', reason: null,
      fetchedAt: '2026-09-24T00:00:00.000Z', cacheAgeMs: 0, feedDelay: 'REALTIME',
      data: { securities: [{ symbol: 'NVDA', name: 'NVIDIA' }], provenance: {
        verification: 'PILOT', sourceUrl: null, rankingMetric: null, period: null, asOfDate: null,
      } },
    };
    const marketRequests = [];
    market = createServer((request, response) => {
      marketRequests.push([request.method, request.url]);
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(liveCatalog));
    });
    await listen(market, marketPort);

    const recovered = await read();
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), liveCatalog);
    assert.deepEqual(marketRequests, [['GET', marketPath]]);

    await close(market);
    const unavailableAgain = await read();
    assert.equal(unavailableAgain.status, 502);
    assert.deepEqual(await unavailableAgain.json(), { error: 'PUBLIC_DATA_UNAVAILABLE' });
  } finally {
    try { if (market?.listening) await close(market); }
    finally {
      try { await stopPreview(preview); }
      finally { await rm(temporaryRoot, { recursive: true, force: true }); }
    }
  }
});

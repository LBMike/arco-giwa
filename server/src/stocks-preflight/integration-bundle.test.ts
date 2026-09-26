import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { a, testManifest } from '../stocks/test-fixtures.js';
import { manifestDigest } from '../stocks/contracts.js';
import { parseStocksRuntimeConfig } from '../stocks-runtime/runtime.js';
import { checkStocksPreflight } from './checker.js';
import { prepareStocksIntegrationBundle } from './integration-bundle.js';
import { parseCorsAllowedOrigins } from '../config/env.js';

function fixture() {
  const manifest = testManifest();
  const settings = { expectedManifestDigest: manifestDigest(manifest), contractPolicyVerified: true,
    rpcUrl: 'https://server-rpc.example.test/private-path', publicRpcUrl: 'https://browser-rpc.example.test/read',
    signerUrl: 'https://signer.example.test', apiBaseUrl: 'https://api.example.test',
    frontendOrigins: ['https://app.example.test:8443'],
    operators: [{ wallet: a(20), operatorId: 'ops-control', permissions: ['stocks:read', 'stocks:control'] },
      { wallet: a(21), operatorId: 'ops-read', permissions: ['stocks:read'] }] };
  return { manifest, settings };
}

test('offline bundle binds the approved manifest and separates browser settings; runtime and preflight consume it unchanged', async () => {
  const f = fixture(), before = JSON.stringify(f);
  const bundle = prepareStocksIntegrationBundle(f.manifest, f.settings);
  const runtime = parseStocksRuntimeConfig(JSON.parse(bundle.runtimeText));
  assert.equal(runtime.paused, true); assert.equal(runtime.operatorControls, true);
  assert.equal(manifestDigest(runtime.manifest), f.settings.expectedManifestDigest);
  assert.equal(bundle.integration.runtimeConfigSha256, createHash('sha256').update(bundle.runtimeText).digest('hex'));
  assert.equal(bundle.integration.tradingAuthorized, false);
  assert.deepEqual(bundle.integration.siweDomains, ['app.example.test:8443']);
  assert.equal(bundle.integration.serverEnvironment.CORS_ALLOWED_ORIGINS, f.settings.frontendOrigins[0]);
  assert.deepEqual(parseCorsAllowedOrigins(bundle.integration.serverEnvironment.CORS_ALLOWED_ORIGINS), bundle.integration.frontendOrigins);
  assert.deepEqual(bundle.integration.browserEnvironment, { VITE_ARCO_API_BASE: f.settings.apiBaseUrl, VITE_PUBLIC_GIWA_RPC: f.settings.publicRpcUrl,
    VITE_CUSTOMER_PRESENTATION: 'true', VITE_GIWA_ADMIN_ADDRESSES: `${a(20)},${a(21)}` });
  assert.ok(!JSON.stringify(bundle.integration.browserEnvironment).includes('server-rpc'));
  assert.ok(!JSON.stringify(bundle.integration.browserEnvironment).includes('signer'));
  const report = await checkStocksPreflight({ ...bundle.integration.serverEnvironment, STOCKS_CONFIG_PATH: '/runtime.json',
    DATABASE_URL: 'postgresql://test@db.example.test/test', STOCKS_SIGNER_TOKEN: 'fixture-only' }, {
    readConfig: async () => runtime, probes: () => { throw new Error('OFFLINE_MUST_NOT_PROBE'); },
  });
  assert.equal(report.status, 'CONFIGURED_NOT_PROBED'); assert.equal(report.tradingAuthorized, false);
  assert.deepEqual(prepareStocksIntegrationBundle(f.manifest, f.settings), bundle);
  assert.equal(JSON.stringify(f), before);
});

test('the fixed UI4392 frontend joins the production origin without relaxing any server endpoint', () => {
  const f = fixture();
  f.settings.frontendOrigins = ['https://app.arco.financial', 'http://127.0.0.1:4392'];
  const bundle = prepareStocksIntegrationBundle(f.manifest, f.settings);
  assert.deepEqual(bundle.integration.siweDomains, ['app.arco.financial', '127.0.0.1:4392']);
  assert.deepEqual(parseCorsAllowedOrigins(bundle.integration.serverEnvironment.CORS_ALLOWED_ORIGINS), f.settings.frontendOrigins);
  for (const value of ['http://localhost:4392', 'http://127.0.0.1:4393', 'http://127.1:4392',
    'http://2130706433:4392', 'http://127.0.0.1:4392/', 'http://127.0.0.1:4392?',
    'http://127.0.0.1:4392#', 'http://127.0.0.1:4392/path', 'http://user@127.0.0.1:4392', 'http://example.test:4392']) {
    assert.throws(() => prepareStocksIntegrationBundle(f.manifest, { ...f.settings, frontendOrigins: [value] }), value);
  }
  for (const key of ['rpcUrl', 'publicRpcUrl', 'signerUrl', 'apiBaseUrl']) {
    assert.throws(() => prepareStocksIntegrationBundle(f.manifest, { ...f.settings, [key]: 'http://127.0.0.1:4392' }), key);
  }
});

test('bundle rejects unapproved, changed or non-public deployment data', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.settings.expectedManifestDigest = '0'.repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.settings.contractPolicyVerified = false; },
    (f: ReturnType<typeof fixture>) => { f.manifest.deploymentId = 'CHANGED_DEPLOYMENT'; },
    (f: ReturnType<typeof fixture>) => { f.manifest.abiDigest = 'a'.repeat(64); },
    (f: ReturnType<typeof fixture>) => { Object.assign(f.manifest, { privateKey: 'DO_NOT_COPY' }); f.settings.expectedManifestDigest = manifestDigest(f.manifest); },
    (f: ReturnType<typeof fixture>) => { Object.assign(f.settings, { paused: false }); },
    (f: ReturnType<typeof fixture>) => { Object.assign(f.settings, { signerToken: 'DO_NOT_COPY' }); },
  ]) { const f = fixture(); mutate(f); assert.throws(() => prepareStocksIntegrationBundle(f.manifest, f.settings)); }
});

test('explicit HTTPS URLs, origins and named operator permissions are required', () => {
  for (const key of ['rpcUrl', 'publicRpcUrl', 'signerUrl', 'apiBaseUrl'] as const) {
    for (const value of ['http://localhost:8080', 'https://user:secret@example.test', 'https://example.test?', 'https://example.test#', ' https://example.test', 'https://example.test\\path', 'https://*.example.test', 'https://example.test,other.test', 'https://example.test%2cother.test']) {
      const f = fixture(); f.settings[key] = value;
      assert.throws(() => prepareStocksIntegrationBundle(f.manifest, f.settings));
    }
  }
  for (const origins of [[], ['*'], ['https://*.example.test'], ['https://app.example.test%2cother.test'], ['https://app.example.test/path'], ['https://app.example.test', 'https://app.example.test/']]) {
    const f = fixture(); f.settings.frontendOrigins = origins;
    assert.throws(() => prepareStocksIntegrationBundle(f.manifest, f.settings));
  }
  const badOperators = [[], [{ wallet: a(20), operatorId: 'read', permissions: ['stocks:read'] }],
    [{ wallet: a(20), operatorId: 'control', permissions: ['stocks:control'] }],
    [{ wallet: a(20), operatorId: 'control', permissions: ['stocks:read', 'stocks:control', 'admin'] }],
    [{ wallet: a(20), operatorId: '\ud800', permissions: ['stocks:read', 'stocks:control'] }],
    [{ wallet: a(0), operatorId: 'control', permissions: ['stocks:read', 'stocks:control'] }]];
  for (const operators of badOperators) {
    const f = fixture(); f.settings.operators = operators;
    assert.throws(() => prepareStocksIntegrationBundle(f.manifest, f.settings));
  }
  for (const field of ['wallet', 'operatorId'] as const) {
    const f = fixture(); Object.assign(f.settings.operators[1], { [field]: f.settings.operators[0][field] });
    assert.throws(() => prepareStocksIntegrationBundle(f.manifest, f.settings));
  }
  const oversized = fixture(); oversized.settings.rpcUrl += '/'.repeat(65536);
  assert.throws(() => prepareStocksIntegrationBundle(oversized.manifest, oversized.settings), /BUNDLE_RUNTIME_CONFIG_TOO_LARGE/);
});

test('CLI emits private-permission files without inherited secrets, rejects overwrite and unsafe paths, and never echoes input errors', () => {
  const temp = mkdtempSync(join(tmpdir(), 'stocks-integration-bundle-'));
  const f = fixture(), input = join(temp, 'manifest.json'), settings = join(temp, 'settings.json'), output = join(temp, 'output');
  writeFileSync(input, JSON.stringify(f.manifest)); writeFileSync(settings, JSON.stringify(f.settings));
  const invoke = (args: string[]) => spawnSync(process.execPath, ['scripts/stocks-preflight/prepare-integration.mjs', ...args],
    { encoding: 'utf8', timeout: 5000, env: { STOCKS_SIGNER_TOKEN: 'NEVER_COPY_THIS', DATABASE_URL: 'NEVER_COPY_THIS' } });
  const args = ['--manifest', input, '--settings', settings, '--output', output];
  try {
    const result = invoke(args);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).status, 'PREPARED_NOT_PROBED');
    assert.deepEqual(readdirSync(output).sort(), ['integration.json', 'runtime-config.json']);
    const original = readFileSync(join(output, 'runtime-config.json'), 'utf8');
    assert.equal(JSON.parse(original).paused, true);
    for (const name of readdirSync(output)) {
      assert.equal(statSync(join(output, name)).mode & 0o777, 0o600);
      assert.ok(!readFileSync(join(output, name), 'utf8').includes('NEVER_COPY_THIS'));
    }
    assert.equal(statSync(output).mode & 0o777, 0o700);
    assert.equal(invoke(args).status, 1); assert.equal(readFileSync(join(output, 'runtime-config.json'), 'utf8'), original);
    for (const bad of [[], [...args, '--token=NEVER_COPY_THIS'], ['--manifest', join(temp, '.env'), ...args.slice(2)],
      [...args.slice(0, 5), join(temp, '.secrets', 'output')], [...args.slice(0, 5), join(temp, '.ENV-copy')]]) {
      const result = invoke(bad); assert.equal(result.status, 1); assert.ok(!result.stdout.includes('NEVER_COPY_THIS')); assert.equal(result.stderr, '');
    }
    const invalid = join(temp, 'invalid.json'), fresh = join(temp, 'fresh');
    writeFileSync(invalid, JSON.stringify({ ...f.settings, signerToken: 'NEVER_COPY_THIS' }));
    const rejected = invoke(['--manifest', input, '--settings', invalid, '--output', fresh]);
    assert.equal(rejected.status, 1); assert.ok(!existsSync(fresh)); assert.ok(!rejected.stdout.includes('NEVER_COPY_THIS'));
    writeFileSync(invalid, ' '.repeat(65537));
    assert.equal(invoke(['--manifest', invalid, ...args.slice(2, 4), '--output', fresh]).status, 1);
    symlinkSync(output, join(temp, 'existing-link'));
    assert.equal(invoke([...args.slice(0, 5), join(temp, 'existing-link')]).status, 1);
    assert.equal(invoke(['--help']).status, 0);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('a hosted signer on the platform private network may use plain HTTP; every other endpoint may not', () => {
  const f = fixture(); f.settings.signerUrl = 'http://arco-stocks-signer:4394/';
  const bundle = prepareStocksIntegrationBundle(f.manifest, f.settings);
  assert.equal(parseStocksRuntimeConfig(JSON.parse(bundle.runtimeText)).signerUrl, 'http://arco-stocks-signer:4394');
  for (const value of ['http://arco-stocks-signer', 'http://arco-stocks-signer:4394/v1', 'http://signer.example.test:4394',
    'http://localhost:4394', 'http://user@arco-stocks-signer:4394', 'http://arco-stocks-signer:4394?'])
    assert.throws(() => prepareStocksIntegrationBundle(f.manifest, { ...f.settings, signerUrl: value }), value);
  for (const key of ['rpcUrl', 'publicRpcUrl', 'apiBaseUrl'] as const)
    assert.throws(() => prepareStocksIntegrationBundle(f.manifest, { ...f.settings, [key]: 'http://arco-stocks-signer:4394' }), key);
});

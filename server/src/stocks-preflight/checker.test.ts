import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { a, testManifest } from '../stocks/test-fixtures.js';
import { checkStocksPreflight, type Prepared, type Check } from './checker.js';
import { boundedProbe } from './adapters.js';

function fixture() {
    const secret = 'DO_NOT_PRINT_SECRET';
    const config = { profile: 'DEMO_TESTNET', manifest: testManifest(), rpcUrl: 'https://rpc.example.test', signerUrl: 'https://signer.example.test', contractPolicyVerified: true, paused: true, operators: [{ wallet: a(10), operatorId: 'reader', permissions: ['stocks:read'] }] };
    const env = { STOCKS_MODE: 'DEMO_TESTNET', STOCKS_AUTODISPATCH: '1', STOCKS_CONFIG_PATH: '/public.json', STOCKS_SIGNER_TOKEN: secret, DATABASE_URL: `postgresql://user:${secret}@db.example.test/test?schema=arco_evm` };
    let reads = 0, creates = 0; const calls: string[] = [];
    const options = {
        readConfig: async () => { reads++; return config; },
        probes: (prepared: Prepared) => {
            creates++; assert.equal(prepared.historySchema, 'arco_evm'); assert.equal(prepared.signerToken, secret);
            return {
                database: async (): Promise<Check[]> => { calls.push('database'); return [{ id: 'vaultBinding', status: 'PASS', code: 'VAULT_UNBOUND_BEFORE_FIRST_START' }]; },
                deployment: async () => { calls.push('deployment'); }, signer: async () => { calls.push('signer'); },
            };
        },
    };
    return { config, env, options, secret, calls, counts: () => ({ reads, creates }) };
}
test('disabled and malformed modes perform no config read or external initialization', async () => {
    const f = fixture();
    assert.equal((await checkStocksPreflight({}, f.options)).status, 'DISABLED');
    assert.equal((await checkStocksPreflight({ STOCKS_MODE: 'DISABLED' }, { ...f.options, online: true })).status, 'DISABLED');
    for (const env of [{ STOCKS_MODE: 'MAINNET' }, { STOCKS_AUTODISPATCH: '1' }, { STOCKS_MODE: 'DEMO_TESTNET', STOCKS_AUTODISPATCH: 'true' }]) assert.equal((await checkStocksPreflight(env, f.options)).status, 'BLOCKED');
    assert.deepEqual(f.counts(), { reads: 0, creates: 0 });
});
test('offline checks configuration with zero probes and never reports readiness or secret values', async () => {
    const f = fixture(), report = await checkStocksPreflight(f.env, f.options);
    assert.equal(report.status, 'CONFIGURED_NOT_PROBED'); assert.equal(report.tradingAuthorized, false);
    assert.equal(report.checks.filter(c => c.status === 'NOT_CHECKED').length, 3);
    assert.deepEqual(f.counts(), { reads: 1, creates: 0 }); assert.deepEqual(f.calls, []);
    assert.ok(!JSON.stringify(report).includes(f.secret)); assert.ok(!JSON.stringify(report).includes('example.test'));
});
test('missing inputs are aggregated and online is blocked before external access', async () => {
    const f = fixture(), report = await checkStocksPreflight({ STOCKS_MODE: 'DEMO_TESTNET' }, { ...f.options, online: true });
    assert.equal(report.status, 'BLOCKED');
    for (const id of ['configuration', 'signerCredential', 'databaseConfiguration', 'autodispatch']) assert.equal(report.checks.find(c => c.id === id)?.status, 'FAIL');
    assert.deepEqual(f.counts(), { reads: 0, creates: 0 });
});
for (const fault of ['manifest', 'signerPath', 'operators', 'duplicateWallet', 'pause', 'databaseSchema', 'blankToken'] as const) test(`configuration ${fault} cannot start probes`, async () => {
    const f = fixture();
    if (fault === 'manifest') (f.config.manifest as unknown as Record<string, unknown>).privateKey = f.secret;
    if (fault === 'signerPath') f.config.signerUrl += '/sign';
    if (fault === 'operators') f.config.operators = [];
    if (fault === 'duplicateWallet') f.config.operators.push({ ...f.config.operators[0] });
    if (fault === 'pause') f.config.paused = false;
    if (fault === 'databaseSchema') f.env.DATABASE_URL += '_other';
    if (fault === 'blankToken') f.env.STOCKS_SIGNER_TOKEN = ' ';
    const report = await checkStocksPreflight(f.env, { ...f.options, online: true });
    assert.equal(report.status, 'BLOCKED'); assert.equal(f.counts().creates, 0); assert.ok(!JSON.stringify(report).includes(f.secret));
});
test('online calls all independent probes and sanitizes synchronous/asynchronous failures', async () => {
    const f = fixture(), report = await checkStocksPreflight(f.env, { ...f.options, online: true, probes: () => ({
        database: () => { f.calls.push('db'); throw new Error(f.secret); },
        deployment: async () => { f.calls.push('rpc'); throw new Error(f.secret); },
        signer: async () => { f.calls.push('signer'); },
    }) });
    assert.deepEqual(f.calls, ['db', 'rpc', 'signer']); assert.equal(report.status, 'BLOCKED');
    assert.equal(report.checks.find(c => c.id === 'signer')?.status, 'PASS'); assert.ok(!JSON.stringify(report).includes(f.secret));
});
test('successful online checks never authorize trades, database finding overrides connectivity success', async () => {
    const f = fixture(), report = await checkStocksPreflight(f.env, { ...f.options, online: true });
    assert.equal(report.status, 'STARTUP_CHECKS_PASSED'); assert.equal(report.tradingAuthorized, false);
    const failed = await checkStocksPreflight(f.env, { ...f.options, online: true, probes: () => ({ database: async () => [{ id: 'migrationHistory', status: 'FAIL', code: 'MIGRATION_HISTORY_MISSING_FAILED_OR_CHANGED' }], deployment: async () => {}, signer: async () => {} }) });
    assert.equal(failed.status, 'BLOCKED');
});
test('probe timeout rejects stalled and synchronously late success', async () => {
    await assert.rejects(boundedProbe(() => new Promise<void>(() => {}), 10), /PREFLIGHT_TIMEOUT/);
    let now = 0;
    await assert.rejects(boundedProbe(async () => { now = 100; }, 50, () => now), /PREFLIGHT_TIMEOUT/);
});
test('CLI defaults offline, emits redacted JSON, and never loads dotenv or echoes bad arguments', () => {
    const f = fixture(), temp = mkdtempSync('/private/tmp/stocks-preflight-cli-');
    try {
        writeFileSync(`${temp}/public.json`, JSON.stringify(f.config));
        const invoke = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ['scripts/stocks-preflight/run.mjs', ...args], { env, encoding: 'utf8', timeout: 3000 });
        const offline = invoke([], { ...f.env, STOCKS_CONFIG_PATH: `${temp}/public.json` });
        assert.equal(offline.status, 2); assert.equal(JSON.parse(offline.stdout).status, 'CONFIGURED_NOT_PROBED');
        assert.ok(!offline.stdout.includes(f.secret)); assert.equal(offline.stderr, '');
        const disabled = invoke([], {}); assert.equal(disabled.status, 2); assert.equal(JSON.parse(disabled.stdout).status, 'DISABLED');
        const bad = invoke([`--token=${f.secret}`], {}); assert.equal(bad.status, 1); assert.ok(!bad.stdout.includes(f.secret));
        const forbidden = invoke([], { ...f.env, STOCKS_CONFIG_PATH: `${temp}/missing.json` });
        assert.equal(forbidden.status, 1); assert.equal(JSON.parse(forbidden.stdout).checks.find((c: Check) => c.id === 'configuration').status, 'FAIL');
    } finally { rmSync(temp, { recursive: true }); }
});

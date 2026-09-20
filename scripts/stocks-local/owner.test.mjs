import assert from 'node:assert/strict';
import test from 'node:test';
import { delimiter, dirname } from 'node:path';
import { checkWorkspace, findPostgres, ownerEnvironment, main } from './owner.mjs';

test('owner environment excludes inherited live credentials, database, hooks and competing scenarios', () => {
  const env = ownerEnvironment({ PATH: '/usr/bin', HOME: '/test-home', LANG: 'ko_KR.UTF-8',
    STOCKS_LOCAL_BROWSER: '1', STOCKS_LOCAL_UI: '1', STOCKS_LOCAL_BROWSER_PROBE: 'failure',
    STOCKS_MODE: 'DEMO_TESTNET', STOCKS_CONFIG_PATH: '/live/config', STOCKS_SIGNER_TOKEN: 'private',
    DATABASE_URL: 'private-db', DIRECT_URL: 'private-db', PGHOST: 'remote',
    STOCKS_SUBMISSIONS_TEST_DATABASE_URL: 'private-db', STOCKS_SUBMISSIONS_EVIDENCE_DIR: '/private/export',
    GIWA_REQUIRE_KEYSTORE: '1', GIWA_KEYSTORE_PASSWORD: 'private', VITE_ARCO_API_BASE: 'https://remote',
    NODE_OPTIONS: '--import private-hook', DOTENV_CONFIG_PATH: '/private/env', TMPDIR: '/very-long/socket/path' });
  assert.deepEqual(env, { PATH: `${dirname(process.execPath)}${delimiter}/usr/bin`, HOME: '/test-home', LANG: 'ko_KR.UTF-8',
    TMPDIR: '/tmp', NODE_OPTIONS: '', DOTENV_CONFIG_PATH: '/dev/null', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    STOCKS_LOCAL_STACK_ONLY: '1', STOCKS_LOCAL_OWNER: '1' });
});

test('explicit PostgreSQL path cannot silently fall back to another installation', () => {
  const present = file => file.startsWith('/installed/bin/');
  assert.equal(findPostgres({ STOCKS_PG_BIN: '/missing/bin', PATH: '/installed/bin' }, present), null);
  assert.equal(findPostgres({ STOCKS_PG_BIN: 'relative/bin', PATH: '/installed/bin' }, () => true), null);
  assert.equal(findPostgres({ STOCKS_PG_BIN: '/installed/bin' }, present), '/installed/bin');
});

test('PG discovery requires all commands and supports Linux and macOS without executing a server', () => {
  assert.equal(findPostgres({ PATH: '/partial:/complete' }, p => p.startsWith('/complete/') || p === '/partial/initdb'), '/complete');
  for (const directory of ['/usr/lib/postgresql/16/bin', '/opt/homebrew/opt/postgresql@18/bin'])
    assert.equal(findPostgres({ PATH: '' }, file => file.startsWith(directory + '/')), directory);
  assert.equal(findPostgres({}, () => false), null);
  assert.equal(findPostgres({ STOCKS_PG_BIN: '/client-only' }, file => !file.endsWith('/postgres')), null,
    'Client-only libpq tools cannot initialize a local server');
});

test('doctor aggregates missing dependencies, unsupported Node and executable failures', () => {
  const calls = [];
  const report = checkWorkspace({ directory: '/workspace', node: '22.14.0', source: { PATH: '' }, present: () => false,
    run: (command, args) => { calls.push({ command, args }); return { status: 1 }; } });
  assert.equal(report.ready, false);
  assert.equal(report.checks.filter(check => !check.ok).length, 6);
  assert.deepEqual(calls, [{ command: 'corepack', args: ['--version'] }]);
});

test('doctor probes versions only and never emits raw command output', () => {
  const calls = [];
  const report = checkWorkspace({ directory: '/workspace', node: '22.15.0', source: { STOCKS_PG_BIN: '/pg/bin' },
    present: () => true, run: (command, args) => { calls.push({ command, args }); return { status: 0, stdout: 'initdb (PostgreSQL) 16.4', stderr: 'PRIVATE' }; } });
  assert.equal(report.ready, true);
  assert.deepEqual(calls, [{ command: 'corepack', args: ['--version'] }, { command: '/pg/bin/initdb', args: ['--version'] }]);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
});

test('doctor refuses unsupported PostgreSQL rather than promising a runnable workspace', () => {
  const report = checkWorkspace({ directory: '/workspace', source: { STOCKS_PG_BIN: '/pg/bin' }, present: () => true,
    run: () => ({ status: 0, stdout: 'initdb (PostgreSQL) 14.0' }) });
  assert.equal(report.ready, false);
  assert.equal(report.checks.find(check => check.id === 'postgresql').ok, false);
});

test('owner CLI rejects remote targets and unknown commands before starting work', async () => {
  for (const args of [[], ['start', 'https://example.com'], ['recovery', 'postgresql://remote/database'], ['deploy'], ['reset', '--force']])
    assert.equal(await main(args), 2);
});

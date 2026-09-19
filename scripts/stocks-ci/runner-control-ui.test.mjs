import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('CI selects only the requested control UI harness, clears inherited modes/DBs, and cannot mask a failed child', { timeout: 15000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'stocks-control-ci-runner-'));
  const ci = join(root, 'scripts/stocks-ci'), local = join(root, 'scripts/stocks-local');
  mkdirSync(ci, { recursive: true }); mkdirSync(local);
  const destination = join(root, 'evidence'), captured = join(root, 'captured.json');
  try {
    for (const file of ['run.mjs', 'evidence.mjs']) copyFileSync(join(import.meta.dirname, file), join(ci, file));
    copyFileSync(join(import.meta.dirname, '../stocks-local/operator-control-ui-checks.mjs'), join(local, 'operator-control-ui-checks.mjs'));
    copyFileSync(join(import.meta.dirname, '../stocks-local/assert-port-closed.mjs'), join(local, 'assert-port-closed.mjs'));
    writeFileSync(join(ci, 'package.json'), '{"name":"local-ci-boundary-fixture","private":true}');
    symlinkSync(join(import.meta.dirname, 'node_modules'), join(ci, 'node_modules'), 'dir');
    writeFileSync(join(local, 'run.mjs'), `
import { writeFileSync } from 'node:fs';
const e = process.env;
writeFileSync(e.FIXTURE_CAPTURE, JSON.stringify({
  scenario: e.STOCKS_LOCAL_BROWSER_CASE, browser: e.STOCKS_LOCAL_BROWSER, local: e.STOCKS_LOCAL_STACK_ONLY,
  probe: e.STOCKS_LOCAL_BROWSER_PROBE ?? null, ui: e.STOCKS_LOCAL_UI ?? null,
  database: e.STOCKS_SUBMISSIONS_TEST_DATABASE_URL ?? null, testDatabase: e.STOCKS_TEST_DATABASE_URL ?? null,
  nodeOptions: e.NODE_OPTIONS, dotenv: e.DOTENV_CONFIG_PATH, evidence: e.STOCKS_LOCAL_BROWSER_EVIDENCE,
}));
// No service, network socket or wallet is started. A nonzero child must remain a CI failure.
process.exitCode = 7;
`);
    const execution = spawnSync(process.execPath, [join(ci, 'run.mjs'), 'operator-control-ui', destination], {
      cwd: root, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, FIXTURE_CAPTURE: captured, STOCKS_LOCAL_CHROME: process.execPath,
        STOCKS_LOCAL_BROWSER_CASE: 'known-hash-ui', STOCKS_LOCAL_BROWSER_PROBE: 'ready', STOCKS_LOCAL_UI: '1',
        STOCKS_SUBMISSIONS_TEST_DATABASE_URL: 'not-a-real-database', STOCKS_TEST_DATABASE_URL: 'not-a-real-database' },
    });
    assert.equal(execution.error, undefined);
    assert.equal(execution.signal, null);
    assert.equal(execution.status, 1, execution.stderr);
    assert.deepEqual(JSON.parse(readFileSync(captured, 'utf8')), {
      scenario: 'operator-control-ui', browser: '1', local: '1', probe: null, ui: null,
      database: null, testDatabase: null, nodeOptions: '', dotenv: '/dev/null', evidence: join(destination, 'browser'),
    });
    const summary = JSON.parse(readFileSync(join(destination, 'summary.json'), 'utf8'));
    assert.equal(summary.scenario, 'operator-control-ui'); assert.equal(summary.result, 'FAIL');
    assert.equal(summary.steps.length, 1);
    assert.deepEqual({ name: summary.steps[0].name, result: summary.steps[0].result, code: summary.steps[0].code },
      { name: 'operator-control-ui', result: 'FAIL', code: 7 });
    assert.equal(summary.browser, undefined, 'Failed child cannot produce accepted browser evidence');
    assert.match(execution.stdout, /"kind":"STOCKS_CI_RESULT".*"result":"FAIL"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

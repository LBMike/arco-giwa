// Fixed local-only CI entry points. Product credentials and deployment config are never loaded.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { assertPortClosed } from '../stocks-local/assert-port-closed.mjs';
import { parseTap, verifyBrowser, verifyLifecycle, verifyOperatorControl } from './evidence.mjs';
import { postgresSuites } from '../stocks-submissions/postgres-suites.mjs';

const root = resolve(import.meta.dirname, '../..');
const [scenario, destination, ...extra] = process.argv.slice(2);
assert.ok(['postgres', 'operator-control', 'operator-control-ui', 'operator-diagnostics', 'known-hash-ui', 'browser-lifecycle', 'owner-workspace'].includes(scenario), 'Choose a fixed Stocks CI scenario');
assert.equal(extra.length, 0);
assert.ok(destination && isAbsolute(destination), 'An absolute, empty evidence directory is required');
mkdirSync(destination, { recursive: true });
assert.equal(readdirSync(destination).length, 0, 'Never reuse evidence from an earlier run');
const [major, minor] = process.versions.node.split('.').map(Number);
assert.ok(major > 22 || major === 22 && minor >= 15, 'Node >=22.15 is required for DOM module hooks');

// Inherited scenario flags must never select a different harness or an existing database.
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(STOCKS_|GIWA_.*DOM_RUNTIME$|GIWA_STOCKS_ARTIFACTS$)/.test(key)) delete env[key];
Object.assign(env, {
  STOCKS_LOCAL_STACK_ONLY: '1',
  TMPDIR: '/tmp',
  NODE_OPTIONS: '',
  DOTENV_CONFIG_PATH: '/dev/null',
  FORCE_COLOR: '0',
});
if (process.env.STOCKS_PG_BIN) env.STOCKS_PG_BIN = process.env.STOCKS_PG_BIN;
const toolsRequire = createRequire(join(import.meta.dirname, 'package.json'));
const jsdom = toolsRequire.resolve('jsdom/package.json');
const playwright = toolsRequire.resolve('playwright/package.json');
const artifactRoot = join(root, 'packages/contracts/artifacts');
env.GIWA_HOST_DOM_RUNTIME = jsdom;
env.GIWA_ADMIN_DOM_RUNTIME = jsdom;
env.GIWA_STOCKS_ARTIFACTS = artifactRoot;

const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
const summary = { scenario, result: 'RUNNING', node: process.version, platform: process.platform,
  head: head.status === 0 ? head.stdout.trim() : null, workingTreeDirty: status.status === 0 ? Boolean(status.stdout.trim()) : null,
  steps: [], startedAt: new Date().toISOString() };
const save = () => writeFileSync(join(destination, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
save();
let child, requestedSignal;
const onSignal = signal => {
  requestedSignal ??= signal;
  // The harness owns its DB/EVM/browser and performs its own ordered teardown.
  child?.kill('SIGTERM');
};
const onInt = () => onSignal('SIGINT'), onTerm = () => onSignal('SIGTERM');
process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);

async function run(name, args, additions = {}) {
  assert.ok(!requestedSignal, 'Stocks CI interrupted');
  const stdoutPath = join(destination, `${name}.stdout.log`), stderrPath = join(destination, `${name}.stderr.log`);
  writeFileSync(stdoutPath, '', { mode: 0o600 }); writeFileSync(stderrPath, '', { mode: 0o600 });
  const record = { name, result: 'RUNNING' }; summary.steps.push(record); save();
  let stdout = '', timedOut = false;
  child = spawn(process.execPath, args, { cwd: root, env: { ...env, ...additions }, stdio: ['ignore', 'pipe', 'pipe'] });
  // Allow real JWT/quote expiration. Never change product deadlines to speed up CI.
  const timer = setTimeout(() => { timedOut = true; child?.kill('SIGTERM'); }, 12 * 60_000);
  child.stdout.on('data', chunk => { stdout += chunk; appendFileSync(stdoutPath, chunk); process.stdout.write(chunk); });
  child.stderr.on('data', chunk => { appendFileSync(stderrPath, chunk); process.stderr.write(chunk); });
  let outcome;
  try {
    outcome = await new Promise((done, fail) => {
      child.once('error', fail);
      child.once('close', (code, signal) => done({ code, signal }));
    });
    Object.assign(record, outcome, { timedOut, result: outcome.code === 0 && !timedOut && !requestedSignal ? 'PASS' : 'FAIL' });
    assert.equal(record.result, 'PASS', `${name} failed or was interrupted; inspect its logs`);
    return stdout;
  } catch (error) {
    record.result = 'FAIL'; record.error = error.message;
    throw error;
  } finally { clearTimeout(timer); child = undefined; save(); }
}

function assertGone(pid, group = false) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1, 'Owned PID required');
  try { process.kill(group ? -pid : pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return; throw error; }
  assert.fail('An owned verification process is still running');
}

try {
  if (scenario === 'postgres') {
    const units = await run('harness-unit', ['--test', '--test-reporter=tap',
      'scripts/stocks-local/browser-server.test.mjs', 'scripts/stocks-local/local-wallet.test.mjs',
      'scripts/stocks-local/owner.test.mjs',
      'scripts/stocks-local/backend-build.test.mjs',
      'scripts/stocks-local/transport-http.test.mjs',
      'scripts/stocks-local/test-cash.test.mjs',
      'scripts/stocks-local/session-report.test.mjs',
      'scripts/stocks-local/startup-chain.test.mjs',
      'scripts/stocks-submissions/backup-state.test.mjs',
      'scripts/stocks-local/short-session.test.mjs', 'scripts/stocks-ci/evidence.test.mjs',
      'scripts/stocks-ci/operator-control-ui.test.mjs', 'scripts/stocks-ci/runner-control-ui.test.mjs',
      'scripts/stocks-ci/port-cleanup.test.mjs', 'scripts/stocks-ci/postgres-harness.test.mjs', 'scripts/stocks-ci/lifecycle-wrapper.test.mjs']);
    summary.harnessTests = parseTap(units);
    const frontend = await run('frontend', ['--import', 'tsx', '--test', '--test-reporter=tap', 'src/demo/giwa/**/*.test.tsx']);
    summary.frontendTests = parseTap(frontend);
    const pgEvidence = join(destination, 'postgres'); mkdirSync(pgEvidence);
    const postgres = await run('postgres', ['scripts/stocks-submissions/test-postgres.mjs', ...postgresSuites],
    { STOCKS_SUBMISSIONS_EVIDENCE_DIR: pgEvidence });
    summary.postgresTests = parseTap(postgres);
    assert.ok(postgres.includes('PROCESS_AND_POSTGRES_RESTART_PERSISTENCE_PASS'));
    assert.ok(postgres.includes('BUY_SELL_ORDER_RECOVERY_AFTER_RESTART_PASS'));
    assert.ok(postgres.includes('TRADING_CONTROL_STATE_HISTORY_AND_IDEMPOTENCY_AFTER_RESTART_PASS'));
    assert.ok(postgres.includes('DATABASE_BACKUP_RESTORE_PERSISTENCE_PASS'));
    assert.ok(postgres.includes('STOCKS_BACKUP_RESTORE_SNAPSHOT_PASS'));
    const proof = JSON.parse(readFileSync(join(pgEvidence, 'harness-evidence.json'), 'utf8'));
    assert.equal(proof.started, true); assert.equal(proof.stopped, true); assert.equal(proof.restarts, 1);
    assert.equal(proof.testsPassed, true); assert.equal(proof.restartVerified, true); assert.equal(proof.interruptedBy, null);
    for (const field of ['created', 'restored', 'sourceRemoved', 'verified', 'archiveRemoved']) assert.equal(proof.backup?.[field], true);
    assert.match(proof.backup.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(proof.backup.bytes) && proof.backup.bytes > 5);
    assert.equal(existsSync(join(proof.temp, 'database.dump')), false);
    summary.databaseBackupRestore = { ...proof.backup };
    assert.deepEqual(proof.stopVerification, { pidFileAbsent: true, socketAbsent: true, recordedPidsExited: true });
    assert.ok(proof.pids.length === 2);
    for (const pid of proof.pids) assertGone(pid);
    assert.equal(existsSync(join(proof.data, 'postmaster.pid')), false);
    assert.equal(existsSync(join(proof.socket, '.s.PGSQL.5432')), false);
    summary.postgresRestartAndCleanup = true;
  } else if (scenario === 'operator-control') {
    const stdout = await run('operator-control', ['scripts/stocks-local/run.mjs']);
    const { result, stopped } = verifyOperatorControl(stdout);
    assertGone(stopped.ownerPid); assertGone(stopped.postgresPid); assertGone(stopped.nodeGroup, true);
    assert.equal(existsSync(stopped.temp), false);
    summary.operatorControl = { checks: result.operatorControl.checks, lastVersion: result.operatorControl.lastVersion,
      scenarios: result.scenarios.length, final: result.final, cleanupVerified: true };
  } else {
    const browserEvidence = join(destination, 'browser'); mkdirSync(browserEvidence);
    env.STOCKS_LOCAL_BROWSER_RUNTIME = playwright;
    env.STOCKS_LOCAL_CHROME = process.env.STOCKS_LOCAL_CHROME || toolsRequire('playwright').chromium.executablePath();
    assert.ok(isAbsolute(env.STOCKS_LOCAL_CHROME) && existsSync(env.STOCKS_LOCAL_CHROME), 'Install the pinned browser first or select an installed local executable');
    env.STOCKS_LOCAL_BROWSER_EVIDENCE = browserEvidence;
    summary.browserExecutable = env.STOCKS_LOCAL_CHROME;
    const owner = scenario === 'owner-workspace', lifecycle = scenario === 'browser-lifecycle';
    const stdout = await run(scenario, [owner ? 'scripts/stocks-local/owner-check.mjs' : lifecycle ? 'scripts/stocks-local/browser-lifecycle-check.mjs' : 'scripts/stocks-local/run.mjs'],
      lifecycle ? {} : { STOCKS_LOCAL_BROWSER: '1', STOCKS_LOCAL_BROWSER_CASE: scenario });
    if (owner) {
      const result = JSON.parse(readFileSync(join(browserEvidence, 'owner-result.json'), 'utf8'));
      assert.equal(result.result, 'PASS'); assert.equal(result.cleanupVerified, true);
      assert.deepEqual(result.pageErrors, []);
      assert.equal(result.checks.length, 11); assert.equal(new Set(result.checks).size, 11);
      assert.ok(result.checks.every(name => typeof name === 'string' && name.trim()));
      assert.equal(result.final.sends, 4); assert.equal(result.final.claimCount, 4);
      assert.deepEqual(result.backendReload, { generation: 2, sessionRetained: true, stateRetained: true });
      assert.equal(result.final.holderStock, '1500000000'); assert.equal(result.final.holderCash, '1820000000');
      assert.equal(result.final.vaultCash, '180000000'); assert.equal(result.final.escrowStock, '0');
      assert.equal(result.final.reconciliationStatus, 'MATCHED_AT_CUTOFF');
      assert.equal(result.topUp.holderCash, '2000000000'); assert.equal(result.topUp.holderStock, '1500000000');
      assert.equal(result.topUp.vaultCash, '180000000'); assert.equal(result.topUp.escrowStock, '0');
      assert.equal(result.topUp.sends, 4); assert.equal(result.topUp.claimCount, 4);
      assert.equal(result.export.kind, 'STOCKS_LOCAL_SESSION_SUMMARY');
      assert.equal(result.export.buyCount, 1); assert.equal(result.export.sellCount, 1); assert.equal(result.export.holderCash, '2000');
      assert.equal(result.ready.initialPaused, true); assert.equal(result.ready.persistentAcrossRestart, false);
      assert.equal(result.ready.ownerPid, result.stopped.ownerPid);
      assert.equal(result.stopped.postgresPidFileAbsent, true); assert.equal(result.stopped.postgresSocketAbsent, true);
      assert.equal(result.stopped.nodeGroupAbsent, true);
      assertGone(result.stopped.ownerPid); assertGone(result.stopped.postgresPid); assertGone(result.stopped.nodeGroup, true);
      assert.equal(existsSync(result.stopped.temp), false);
      await Promise.all([result.ready.origin, result.ready.apiBase, result.ready.rpcUrl].map(base => assertPortClosed(base)));
      summary.ownerWorkspace = { checks: result.checks, final: result.final, cleanupVerified: true };
    } else if (lifecycle) {
      summary.lifecycle = verifyLifecycle(stdout);
    } else {
      const result = JSON.parse(readFileSync(join(browserEvidence, 'result.json'), 'utf8'));
      const { ready, resources, stopped } = verifyBrowser({ stdout, result, scenario });
      for (const pid of [ready.ownerPid, resources.chromePid, stopped.postgresPid]) assertGone(pid);
      assertGone(stopped.nodeGroup, true);
      assert.equal(existsSync(join(stopped.postgresData, 'postmaster.pid')), false);
      assert.equal(existsSync(join(stopped.socket, '.s.PGSQL.5432')), false);
      await Promise.all([ready.apiBase, ready.origin, ready.rpcUrl].map(base => assertPortClosed(base)));
      if (scenario === 'operator-control-ui') assert.equal(existsSync(stopped.temp), false, 'Owned control UI scratch directory remains');
      summary.browser = { version: result.browserVersion, scenarioGroups: result.scenarios.length,
        diagnosticsCases: result.operatorDiagnostics?.cases.length, diagnosticsGroups: result.operatorDiagnostics?.checks.length,
        cleanupVerified: true };
      if (scenario === 'operator-control-ui') summary.browser.operatorControl = {
        checkIds: result.operatorControl.checkIds, checks: result.operatorControl.checks.length,
        walletSends: result.operatorControl.walletSends, investorSends: result.dispatchEvidence.attempts.length,
        finalVersion: result.operatorControl.finalControl.version, reconciliation: result.final.snapshot.reconciliation.status,
      };
    }
  }
  assert.ok(!requestedSignal, 'Stocks CI interrupted');
  summary.result = 'PASS';
} catch (error) {
  summary.result = 'FAIL'; summary.error = error.message;
  process.exitCode = requestedSignal === 'SIGINT' ? 130 : requestedSignal ? 143 : 1;
  console.error(`Stocks CI failed: ${error.message}`);
} finally {
  summary.finishedAt = new Date().toISOString(); save();
  process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
  console.log(JSON.stringify({ kind: 'STOCKS_CI_RESULT', scenario, result: summary.result, evidence: destination }));
}

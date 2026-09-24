import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const source = resolve(import.meta.dirname, '../stocks-submissions/test-postgres.mjs');

// Black-box command fixtures exercise the harness protocol without starting PG,
// binding a socket, or reading a database. The nested node:test runner is real.
function fixture(t, mode = 'pass', overrideBin = false) {
  const root = mkdtempSync(join(tmpdir(), 'pg-harness-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, 'scripts/stocks-submissions');
  const tests = join(root, 'server/dist/stocks-submissions');
  const bin = join(root, 'bin');
  const runtime = join(root, 'runtime');
  const artifacts = join(root, 'artifacts');
  for (const directory of [scripts, tests, bin, runtime]) mkdirSync(directory, { recursive: true });
  const harness = join(scripts, 'test-postgres.mjs');
  copyFileSync(source, harness);
  const command = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const command = path.basename(process.argv[1]);
const data = args.includes('-D') ? args[args.indexOf('-D') + 1] : null;
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ command, args }) + '\\n');
if (command === 'initdb') {
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'raw-private-db'), 'must not publish');
}
if (command === 'createdb' && process.env.FIXTURE_MODE.startsWith('signal')) {
  console.log('FIXTURE_CHILD_READY ' + process.pid);
  setInterval(() => {}, 1000);
}
if (command === 'pg_dump') {
  fs.writeFileSync(args[args.indexOf('-f') + 1], process.env.FIXTURE_MODE === 'bad-archive' ? 'invalid' : 'PGDMPfixture archive');
  if (process.env.FIXTURE_MODE === 'dump-fail') process.exitCode = 1;
}
if (command === 'pg_restore' && process.env.FIXTURE_MODE === 'restore-fail') process.exitCode = 1;
if (command === 'dropdb' && process.env.FIXTURE_MODE === 'drop-fail') process.exitCode = 1;
if (command === 'pg_restore' && process.env.FIXTURE_MODE === 'backup-signal') {
  console.log('FIXTURE_CHILD_READY ' + process.pid);
  setInterval(() => {}, 1000);
}
if (command === 'pg_ctl') {
  const socket = path.join(path.dirname(data), 'socket', '.s.PGSQL.5432');
  if (args.at(-1) === 'start') {
    fs.writeFileSync(path.join(data, 'postmaster.pid'), String(process.pid) + '\\n');
    fs.writeFileSync(socket, 'fixture only');
    if (process.env.FIXTURE_MODE === 'start-fail') process.exitCode = 1;
  } else if (process.env.FIXTURE_MODE === 'stop-fail') {
    process.exitCode = 1;
  } else {
    const finish = () => {
      fs.rmSync(path.join(data, 'postmaster.pid'), { force: true });
      fs.rmSync(socket, { force: true });
    };
    if (process.env.FIXTURE_MODE === 'signal-repeat') {
      console.log('FIXTURE_STOP_READY');
      setTimeout(finish, 100);
    } else finish();
  }
}
`;
  for (const name of ['initdb', 'pg_ctl', 'createdb', 'psql', 'pg_dump', 'pg_restore', 'dropdb']) writeFileSync(join(bin, name), command, { mode: 0o755 });
  writeFileSync(join(tests, 'postgres.test.js'), `const test = require('node:test'); test('database fixture', () => { if (process.env.FIXTURE_MODE === 'test-fail') throw new Error('intentional failure'); });`);
  writeFileSync(join(tests, 'receipts.postgres.test.js'), `const test = require('node:test'); test('receipt fixture', () => {});`);
  writeFileSync(join(scripts, 'restart-probe.mjs'), `import { appendFileSync, writeFileSync, readFileSync } from 'node:fs';
appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ probe: process.argv[2] }) + '\\n');
if (process.argv[2] === 'seed') writeFileSync(process.env.STOCKS_SUBMISSIONS_RESTART_FILE, 'private restart fixture');
else if (readFileSync(process.env.STOCKS_SUBMISSIONS_RESTART_FILE, 'utf8') !== 'private restart fixture') throw new Error('RESTART_FIXTURE_MISSING');
`);
  writeFileSync(join(scripts, 'backup-probe.mjs'), `import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync, readFileSync } from 'node:fs';
const phase = process.argv[2];
appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ backupProbe: phase }) + '\\n');
assert.equal(new URL(process.env.STOCKS_SUBMISSIONS_TEST_DATABASE_URL).pathname, phase === 'capture' ? '/submissions_test' : '/submissions_restored');
if (phase === 'capture') writeFileSync(process.env.STOCKS_SUBMISSIONS_TEST_BACKUP_FILE, 'snapshot');
else { assert.equal(readFileSync(process.env.STOCKS_SUBMISSIONS_TEST_BACKUP_FILE, 'utf8'), 'snapshot'); if(process.env.FIXTURE_MODE === 'verify-fail') throw Error('snapshot mismatch'); }
`);
  const env = { PATH: overrideBin ? '' : bin, TMPDIR: runtime, TMP: runtime, TEMP: runtime, FIXTURE_MODE: mode, FIXTURE_LOG: join(root, 'commands.jsonl'), STOCKS_SUBMISSIONS_EVIDENCE_DIR: artifacts };
  if (overrideBin) env.STOCKS_PG_BIN = bin;
  return { root, harness, env, runtime, artifacts };
}

async function runFixture(t, fixture, signal) {
  const child = spawn(process.execPath, [fixture.harness], { env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', sent = false, repeated = false, workerPid;
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  t.after(() => {
    clearTimeout(timeout);
    if (workerPid) try { process.kill(-workerPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    const ready = stdout.match(/FIXTURE_CHILD_READY (\d+)/);
    if (ready) workerPid = Number(ready[1]);
    if (signal && ready && !sent) { sent = true; child.kill(signal); }
    if (fixture.env.FIXTURE_MODE === 'signal-repeat' && stdout.includes('FIXTURE_STOP_READY') && !repeated) { repeated = true; child.kill('SIGINT'); }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const result = await new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', (code, exitSignal) => resolveResult({ code, exitSignal }));
  });
  clearTimeout(timeout);
  const evidence = JSON.parse(readFileSync(join(fixture.artifacts, 'harness-evidence.json'), 'utf8'));
  const commands = readFileSync(fixture.env.FIXTURE_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { ...result, stdout, stderr, evidence, commands, workerPid, repeated };
}

function assertStopped(evidence) {
  assert.equal(evidence.stopped, true);
  assert.deepEqual(evidence.stopVerification, { pidFileAbsent: true, socketAbsent: true, recordedPidsExited: true });
}

for (const overrideBin of [false, true]) test(`portable PG lookup via ${overrideBin ? 'explicit bin' : 'PATH'} preserves restart and exports JSON only`, { timeout: 20000 }, async t => {
  const setup = fixture(t, 'pass', overrideBin);
  const result = await runFixture(t, setup);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.exitSignal, null);
  assert.equal(result.evidence.started, true);
  assertStopped(result.evidence);
  assert.equal(result.evidence.testsPassed, true);
  assert.equal(result.evidence.restartVerified, true);
  assert.equal(result.evidence.restarts, 1);
  assert.equal(result.evidence.interruptedBy, null);
  assert.deepEqual(Object.fromEntries(['created', 'restored', 'sourceRemoved', 'verified', 'archiveRemoved'].map(key => [key, result.evidence.backup[key]])),
    { created: true, restored: true, sourceRemoved: true, verified: true, archiveRemoved: true });
  assert.match(result.evidence.backup.sha256, /^[a-f0-9]{64}$/);
  assert.match(result.stdout, /DATABASE_BACKUP_RESTORE_PERSISTENCE_PASS/);
  assert.equal(result.evidence.temp.startsWith(setup.runtime + '/'), true);
  assert.deepEqual(readdirSync(setup.artifacts), ['harness-evidence.json']);
  assert.match(result.stdout, /TAP version 13/);
  assert.match(result.stdout, /# fail 0/);
  assert.match(result.stdout, /# skipped 0/);
  assert.match(result.stdout, /OWNED_PG_READY /);
  assert.match(result.stdout, /OWNED_PG_EVIDENCE /);
  const protocol = result.commands.filter(entry => entry.command === 'pg_ctl' || entry.probe).map(entry => entry.probe ?? entry.args.at(-1));
  assert.deepEqual(protocol, ['start', 'seed', 'stop', 'start', 'verify', 'verify', 'stop']);
  const restoreProtocol = result.commands.filter(entry => ['pg_dump', 'pg_restore', 'dropdb'].includes(entry.command) || entry.backupProbe)
    .map(entry => entry.backupProbe ?? entry.command);
  assert.deepEqual(restoreProtocol, ['capture', 'pg_dump', 'pg_restore', 'dropdb', 'verify']);
  const restore = result.commands.find(entry => entry.command === 'pg_restore');
  assert.ok(restore.args.includes('--exit-on-error') && restore.args.includes('--single-transaction'));
  assert.equal(restore.args[restore.args.indexOf('-d') + 1], 'submissions_restored');
});

test('failed database tests stop owned PG and publish failure evidence without claiming restart', { timeout: 20000 }, async t => {
  const result = await runFixture(t, fixture(t, 'test-fail'));
  assert.equal(result.code, 1);
  assertStopped(result.evidence);
  assert.equal(result.evidence.testsPassed, false);
  assert.equal(result.evidence.restartVerified, false);
  assert.equal(result.evidence.restarts, 0);
  assert.equal(result.commands.some(entry => entry.probe), false);
});

test('failed start still cleans partial owned PG state', { timeout: 20000 }, async t => {
  const result = await runFixture(t, fixture(t, 'start-fail'));
  assert.equal(result.code, 1);
  assert.equal(result.evidence.started, false);
  assertStopped(result.evidence);
  assert.equal(result.evidence.pids.length, 1);
});

test('failed cleanup remains failing and exports negative shutdown evidence', { timeout: 20000 }, async t => {
  const result = await runFixture(t, fixture(t, 'stop-fail'));
  assert.equal(result.code, 1);
  assert.equal(result.evidence.stopped, false);
  assert.equal(result.evidence.stopVerification.pidFileAbsent, false);
  assert.equal(result.evidence.stopVerification.socketAbsent, false);
  assert.equal(result.evidence.restartVerified, false);
  assert.match(result.stdout, /OWNED_PG_EVIDENCE /);
});

for (const signal of ['SIGINT', 'SIGTERM']) test(`${signal} stops its active child and owned PG, publishes evidence, and preserves cancellation exit`, { timeout: 20000 }, async t => {
  const result = await runFixture(t, fixture(t, 'signal'), signal);
  assert.equal(result.code, signal === 'SIGINT' ? 130 : 143);
  assert.equal(result.exitSignal, null);
  assert.equal(result.evidence.interruptedBy, signal);
  assertStopped(result.evidence);
  assert.equal(result.evidence.testsPassed, false);
  assert.equal(result.evidence.restartVerified, false);
  assert.throws(() => process.kill(result.workerPid, 0), { code: 'ESRCH' });
});

test('repeated cancellation during cleanup does not interrupt the single owned stop', { timeout: 20000 }, async t => {
  const result = await runFixture(t, fixture(t, 'signal-repeat'), 'SIGTERM');
  assert.equal(result.code, 143);
  assert.equal(result.repeated, true);
  assertStopped(result.evidence);
  assert.equal(result.evidence.interruptedBy, 'SIGTERM');
  assert.equal(result.commands.filter(entry => entry.command === 'pg_ctl' && entry.args.at(-1) === 'stop').length, 1);
});

for (const mode of ['dump-fail', 'bad-archive', 'restore-fail', 'drop-fail', 'verify-fail'])
  test(`${mode} never reports successful restore, stops PG and removes the archive`, { timeout: 20000 }, async t => {
    const result = await runFixture(t, fixture(t, mode));
    assert.equal(result.code, 1); assertStopped(result.evidence);
    assert.equal(result.evidence.backup.verified, false);
    assert.equal(result.evidence.backup.archiveRemoved, true);
    assert.doesNotMatch(result.stdout, /DATABASE_BACKUP_RESTORE_PERSISTENCE_PASS/);
    assert.deepEqual(readdirSync(join(result.evidence.temp)).filter(name => name === 'database.dump'), []);
    if (['dump-fail', 'bad-archive', 'restore-fail'].includes(mode)) assert.equal(result.commands.some(row => row.command === 'dropdb'), false);
  });

test('cancellation during restore terminates the child, removes the archive and stops PG', { timeout: 20000 }, async t => {
  const result = await runFixture(t, fixture(t, 'backup-signal'), 'SIGTERM');
  assert.equal(result.code, 143); assertStopped(result.evidence);
  assert.equal(result.evidence.backup.verified, false); assert.equal(result.evidence.backup.archiveRemoved, true);
  assert.equal(result.commands.some(row => row.command === 'dropdb'), false);
  assert.throws(() => process.kill(result.workerPid, 0), { code: 'ESRCH' });
});

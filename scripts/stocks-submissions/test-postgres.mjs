import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, realpathSync, statSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const extra = process.argv.slice(2).map(value => {
  const path = realpathSync(resolve(root, value));
  if (relative(root, path).startsWith('..') || !statSync(path).isFile() || !/\.(?:test\.js|mjs)$/.test(path)) throw new Error('INVALID_EXPLICIT_TEST_FILE');
  return path;
});
const bin = process.env.STOCKS_PG_BIN;
const temp = mkdtempSync(join(tmpdir(), 'stocks-submissions-pg-'));
const data = join(temp, 'data'), socket = join(temp, 'socket');
mkdirSync(socket);
const evidencePath = join(temp, 'harness-evidence.json');
const evidence = { temp, data, socket, tcp: false, started: false, stopped: false, testsPassed: false, restartVerified: false, restarts: 0, pids: [], interruptedBy: null,
  backup: { created: false, restored: false, sourceRemoved: false, verified: false, archiveRemoved: false } };
const archive = join(temp, 'database.dump');
let activeChild;
let cleaningUp = false;

function signalChild(child, signal) {
  if (!child.process.pid) return;
  try { process.kill(-child.process.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  evidence.interruptedBy ??= signal;
  if (cleaningUp || !activeChild) return;
  const child = activeChild;
  signalChild(child, signal);
  child.killTimer ??= setTimeout(() => { if (activeChild === child) signalChild(child, 'SIGKILL'); }, 2000);
});

function run(command, args, env, { cleanup = false, timeoutMs = 0 } = {}) {
  if (evidence.interruptedBy && !cleanup) throw new Error('HARNESS_INTERRUPTED');
  return new Promise((resolveRun, reject) => {
    const child = { process: spawn(command, args, { cwd: root, stdio: 'inherit', env: env ?? process.env, detached: true }), killTimer: null };
    activeChild = child;
    const timeout = timeoutMs ? setTimeout(() => signalChild(child, 'SIGKILL'), timeoutMs) : null;
    child.process.once('error', () => finish(false));
    child.process.once('close', (status) => finish(status === 0));
    let finished = false;
    function finish(success) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(child.killTimer);
      if (activeChild === child) activeChild = undefined;
      if (success) resolveRun();
      else reject(new Error(`HARNESS_COMMAND_FAILED:${command.split('/').pop()}`));
    }
  });
}
function pg(command, args, options) { return run(bin ? join(bin, command) : command, args, undefined, options); }
function rememberPid() {
  if (!existsSync(join(data, 'postmaster.pid'))) return;
  const pid = Number(readFileSync(join(data, 'postmaster.pid'), 'utf8').split('\n')[0]);
  if (Number.isSafeInteger(pid) && pid > 0 && !evidence.pids.includes(pid)) evidence.pids.push(pid);
}
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }
function writeEvidence() { writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n'); }
async function start() {
  await pg('pg_ctl', ['-D', data, '-l', join(temp, 'postgres.log'), '-o', `-k '${socket.replaceAll("'", "'\\''")}' -h '' -p 5432 -c fsync=on -c shared_memory_type=mmap -c dynamic_shared_memory_type=mmap -c shared_buffers=16MB -c max_connections=20`, '-t', '10', '-w', 'start']);
  evidence.started = true;
  evidence.stopped = false;
  rememberPid();
  writeEvidence();
  console.log(`OWNED_PG_READY ${evidencePath}`);
}
async function stop() {
  evidence.stopped = false;
  try {
    rememberPid();
    if (existsSync(join(data, 'postmaster.pid'))) await pg('pg_ctl', ['-D', data, '-m', 'fast', '-t', '10', '-w', 'stop'], { cleanup: true, timeoutMs: 15000 });
  } finally {
    evidence.stopVerification = {
      pidFileAbsent: !existsSync(join(data, 'postmaster.pid')),
      socketAbsent: !existsSync(join(socket, '.s.PGSQL.5432')) && !existsSync(join(socket, '.s.PGSQL.5432.lock')),
      recordedPidsExited: evidence.pids.every(pid => !isAlive(pid)),
    };
    evidence.stopped = Object.values(evidence.stopVerification).every(Boolean);
  }
  if (!evidence.stopped) throw new Error('OWNED_DATABASE_STILL_RUNNING');
}

let failure;
try {
  await pg('initdb', ['-D', data, '-A', 'trust', '--no-locale', '-E', 'UTF8', '-U', 'submissions_harness', '-c', 'shared_memory_type=mmap', '-c', 'dynamic_shared_memory_type=mmap', '-c', 'shared_buffers=16MB', '-c', 'max_connections=20']);
  await start();
  await pg('createdb', ['-h', socket, '-U', 'submissions_harness', 'submissions_test']);
  const psql = ['-h', socket, '-U', 'submissions_harness', '-d', 'submissions_test', '-v', 'ON_ERROR_STOP=1'];
  await pg('psql', [...psql, '-c', 'CREATE SCHEMA arco_evm']);
  for (const migration of ['20260916000000_stocks_testnet', '20260917000000_stocks_redemption', '20260918000000_stocks_wallet_submissions', '20260919000000_stocks_wallet_receipts', '20260920000000_stocks_trading_control']) await pg('psql', [...psql, '-f', join(root, 'prisma/migrations', migration, 'migration.sql')]);
  const env = { ...process.env, STOCKS_SUBMISSIONS_TEST_ONLY: '1', STOCKS_SUBMISSIONS_RESTART_FILE: join(temp, 'restart-fixture.json'), STOCKS_SUBMISSIONS_TEST_DATABASE_URL: `postgresql://submissions_harness@localhost/submissions_test?host=${encodeURIComponent(socket)}` };
  env.STOCKS_TEST_HARNESS_ONLY = '1'; env.STOCKS_TEST_DATABASE_URL = env.STOCKS_SUBMISSIONS_TEST_DATABASE_URL;
  await run(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', 'server/dist/stocks-submissions/postgres.test.js', 'server/dist/stocks-submissions/receipts.postgres.test.js', ...extra], env);
  evidence.testsPassed = true;
  await run(process.execPath, ['scripts/stocks-submissions/restart-probe.mjs', 'seed'], env);
  await stop();
  await start();
  evidence.restarts++;
  await run(process.execPath, ['scripts/stocks-submissions/restart-probe.mjs', 'verify'], env);
  evidence.restartVerified = true;
  // All test clients have exited. Back up only this harness-owned database and
  // restore into a new database; no caller-supplied database target is accepted.
  env.STOCKS_SUBMISSIONS_TEST_BACKUP_FILE = join(temp, 'backup-baseline.json');
  await run(process.execPath, ['scripts/stocks-submissions/backup-probe.mjs', 'capture'], env);
  await pg('pg_dump', ['-h', socket, '-U', 'submissions_harness', '-d', 'submissions_test', '--format=custom', '--no-owner', '--no-privileges', '-f', archive]);
  chmodSync(archive, 0o600);
  const bytes = readFileSync(archive);
  if (bytes.subarray(0, 5).toString() !== 'PGDMP') throw new Error('INVALID_BACKUP_ARCHIVE');
  Object.assign(evidence.backup, { created: true, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  await pg('createdb', ['-h', socket, '-U', 'submissions_harness', 'submissions_restored']);
  await pg('pg_restore', ['-h', socket, '-U', 'submissions_harness', '-d', 'submissions_restored', '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', archive]);
  evidence.backup.restored = true;
  await pg('dropdb', ['-h', socket, '-U', 'submissions_harness', 'submissions_test']);
  evidence.backup.sourceRemoved = true;
  const restoredEnv = { ...env, STOCKS_SUBMISSIONS_TEST_DATABASE_URL: `postgresql://submissions_harness@localhost/submissions_restored?host=${encodeURIComponent(socket)}` };
  restoredEnv.STOCKS_TEST_DATABASE_URL = restoredEnv.STOCKS_SUBMISSIONS_TEST_DATABASE_URL;
  await run(process.execPath, ['scripts/stocks-submissions/backup-probe.mjs', 'verify'], restoredEnv);
  await run(process.execPath, ['scripts/stocks-submissions/restart-probe.mjs', 'verify'], restoredEnv);
  evidence.backup.verified = true;
  console.log('DATABASE_BACKUP_RESTORE_PERSISTENCE_PASS');
} catch (error) {
  failure = error;
} finally {
  cleaningUp = true;
  try { await stop(); } catch (error) { failure = error; }
  // A rehearsal archive is not a retained operational backup. Never export it.
  try { rmSync(archive, { force: true }); evidence.backup.archiveRemoved = !existsSync(archive); }
  catch { failure = new Error('BACKUP_ARCHIVE_CLEANUP_FAILED'); }
  // SIGKILL or host loss cannot run this finally block. Publish only the small
  // ownership/cleanup record; the DB, fixture state and logs stay in the temp dir.
  try {
    writeEvidence();
    console.log(`OWNED_PG_EVIDENCE ${evidencePath}`);
    if (process.env.STOCKS_SUBMISSIONS_EVIDENCE_DIR) {
      const destination = resolve(process.env.STOCKS_SUBMISSIONS_EVIDENCE_DIR);
      mkdirSync(destination, { recursive: true });
      if (resolve(evidencePath) !== join(destination, 'harness-evidence.json')) copyFileSync(evidencePath, join(destination, 'harness-evidence.json'));
    }
  } catch (error) { failure = new Error(`HARNESS_EVIDENCE_FAILED:${error.code ?? 'UNKNOWN'}`); }
}
if (failure) console.error(failure.message);
process.exitCode = evidence.interruptedBy === 'SIGINT' ? 130 : evidence.interruptedBy === 'SIGTERM' ? 143 : failure ? 1 : 0;

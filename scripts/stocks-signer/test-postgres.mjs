import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { findPostgres } from '../stocks-local/owner.mjs';

const root = resolve(import.meta.dirname, '../..');
const bin = findPostgres();
if (!bin) throw new Error('SIGNER_TEST_POSTGRES_SERVER_BIN_UNAVAILABLE');
const temp = mkdtempSync(join(tmpdir(), 'stocks-signer-pg-'));
const data = join(temp, 'data'), socket = join(temp, 'socket');
mkdirSync(socket);
const pg = name => join(bin, name);
let started = false;
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`SIGNER_TEST_COMMAND_FAILED:${command.split('/').pop()}`);
}
function start() {
  run(pg('pg_ctl'), ['-D', data, '-l', join(temp, 'postgres.log'), '-o',
    `-k ${socket} -h '' -p 5432 -c shared_memory_type=mmap -c dynamic_shared_memory_type=mmap -c shared_buffers=16MB -c max_connections=20`, '-w', 'start']);
  started = true;
}
function stop() {
  run(pg('pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']);
  started = false;
}
try {
  run(pg('initdb'), ['-D', data, '-A', 'trust', '--no-locale', '-E', 'UTF8', '-U', 'signer_harness',
    '-c', 'shared_memory_type=mmap', '-c', 'dynamic_shared_memory_type=mmap', '-c', 'shared_buffers=16MB', '-c', 'max_connections=20']);
  start();
  run(pg('createdb'), ['-h', socket, '-U', 'signer_harness', 'signer_test']);
  run(pg('psql'), ['-h', socket, '-U', 'signer_harness', '-d', 'signer_test', '-v', 'ON_ERROR_STOP=1',
    '-f', join(root, 'server/src/stocks-signer/migrations/0001_journal.sql')]);
  run(pg('psql'), ['-h', socket, '-U', 'signer_harness', '-d', 'signer_test', '-v', 'ON_ERROR_STOP=1',
    '-f', join(root, 'server/src/stocks-signer/migrations/0002_signed_intent.sql')]);
  // Old rows have no authenticated signed bytes. Prove the additive migration
  // refuses them atomically instead of silently creating unresolvable records.
  run(pg('createdb'), ['-h', socket, '-U', 'signer_harness', 'signer_migration_guard']);
  run(pg('psql'), ['-h', socket, '-U', 'signer_harness', '-d', 'signer_migration_guard', '-v', 'ON_ERROR_STOP=1',
    '-f', join(root, 'server/src/stocks-signer/migrations/0001_journal.sql')]);
  run(pg('psql'), ['-h', socket, '-U', 'signer_harness', '-d', 'signer_migration_guard', '-v', 'ON_ERROR_STOP=1', '-c', `
    INSERT INTO stocks_signer.account_nonce
      ("chainId","signerAddress","networkInstance","checkpointNumber","checkpointHash","initialNonce","nextNonce")
      VALUES (91342,'0x${'1'.repeat(40)}','TEST_HARNESS_ONLY_NETWORK_V1','1','0x${'2'.repeat(64)}',0,0);
    INSERT INTO stocks_signer.operation
      ("operationId","chainId","signerAddress","deploymentDigest","callDigest",call,"originalNonce")
      VALUES ('mint:migration-guard',91342,'0x${'1'.repeat(40)}','${'a'.repeat(64)}','${'b'.repeat(64)}','{}'::jsonb,0);
  `]);
  const denied = spawnSync(pg('psql'), ['-h', socket, '-U', 'signer_harness', '-d', 'signer_migration_guard',
    '-v', 'ON_ERROR_STOP=1', '-f', join(root, 'server/src/stocks-signer/migrations/0002_signed_intent.sql')],
  { cwd: root, encoding: 'utf8' });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /SIGNER_SIGNED_INTENT_MIGRATION_REQUIRES_EMPTY_OPERATION_TABLE/);
  const rolledBack = spawnSync(pg('psql'), ['-h', socket, '-U', 'signer_harness', '-d', 'signer_migration_guard',
    '-t', '-A', '-c', "SELECT to_regclass('stocks_signer.signed_intent') IS NULL"], { cwd: root, encoding: 'utf8' });
  assert.equal(rolledBack.status, 0);
  assert.equal(rolledBack.stdout.trim(), 't');
  console.log('SIGNER_SIGNED_INTENT_MIGRATION_GUARD_PASSED');
  run('npm', ['run', 'build:server']);
  const connection = `postgresql://signer_harness@localhost/signer_test?host=${encodeURIComponent(socket)}`;
  const testEnv = { ...process.env, STOCKS_SIGNER_TEST_ONLY: '1', STOCKS_SIGNER_TEST_DATABASE_URL: connection };
  run(process.execPath, ['--test', '--test-concurrency=1', 'server/dist/stocks-signer/postgres-journal.postgres.test.js'], testEnv);
  run(process.execPath, ['scripts/stocks-signer/restart-probe.mjs', 'seed'], testEnv);
  stop();
  start();
  run(process.execPath, ['scripts/stocks-signer/restart-probe.mjs', 'verify'], testEnv);
  run(process.execPath, ['--test', 'scripts/stocks-signer/original-transport-evm.test.mjs'], testEnv);
} finally {
  if (started || existsSync(join(data, 'postmaster.pid'))) {
    const stopped = spawnSync(pg('pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'inherit' });
    if (stopped.error || stopped.status !== 0 || existsSync(join(data, 'postmaster.pid')))
      throw new Error(`SIGNER_TEST_DATABASE_STILL_RUNNING:${temp}`);
  }
  rmSync(temp, { recursive: true, force: true });
}

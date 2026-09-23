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
  run('npm', ['run', 'build:server']);
  const connection = `postgresql://signer_harness@localhost/signer_test?host=${encodeURIComponent(socket)}`;
  const testEnv = { ...process.env, STOCKS_SIGNER_TEST_ONLY: '1', STOCKS_SIGNER_TEST_DATABASE_URL: connection };
  run(process.execPath, ['--test', '--test-concurrency=1', 'server/dist/stocks-signer/postgres-journal.postgres.test.js'], testEnv);
  run(process.execPath, ['scripts/stocks-signer/restart-probe.mjs', 'seed'], testEnv);
  stop();
  start();
  run(process.execPath, ['scripts/stocks-signer/restart-probe.mjs', 'verify'], testEnv);
} finally {
  if (started || existsSync(join(data, 'postmaster.pid'))) {
    const stopped = spawnSync(pg('pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'inherit' });
    if (stopped.error || stopped.status !== 0 || existsSync(join(data, 'postmaster.pid')))
      throw new Error(`SIGNER_TEST_DATABASE_STILL_RUNNING:${temp}`);
  }
  rmSync(temp, { recursive: true, force: true });
}

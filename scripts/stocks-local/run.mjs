import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync, openSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.env.STOCKS_LOCAL_STACK_ONLY, '1', 'Explicit STOCKS_LOCAL_STACK_ONLY=1 is required');
const root = resolve(import.meta.dirname, '../..');
const contractsRoot = join(root, 'packages/contracts');
assert.ok(existsSync(join(root, 'server/dist/stocks-runtime/observer.js')), 'Build the assembled backend/runtime first');
assert.ok(existsSync(join(contractsRoot, 'node_modules/.bin/hardhat')), 'Install existing contract dependencies first');
const temp = mkdtempSync(join(tmpdir(), 'stocks-local-stack-'));
const socket = join(temp, 'socket'); mkdirSync(socket);
const data = join(temp, 'postgres');
const log = join(temp, 'run.log'); const fd = openSync(log, 'a', 0o600);
let pgStarted = false; let node;
const pg = command => process.env.STOCKS_PG_BIN ? join(process.env.STOCKS_PG_BIN, command) : command;
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: ['ignore', fd, fd], ...options });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} failed (${result.status}); local diagnostics retained at ${log}`);
};
async function freePort() {
  const server = createServer();
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}
let successful = false;
try {
  const { ABI_DIGEST } = await import('../../server/dist/stocks/contracts.js');
  run('corepack', ['yarn', 'hardhat', '--config', 'hardhat.stocks.config.ts', 'compile'], { cwd: contractsRoot });
  const port = await freePort(); const rpcUrl = `http://127.0.0.1:${port}`;
  node = spawn('corepack', ['yarn', 'hardhat', '--config', 'hardhat.stocks.config.ts', 'node', '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd: contractsRoot, stdio: ['ignore', fd, fd], detached: true });
  let ready = false;
  for (let n = 0; n < 60; n++) {
    if (node.exitCode !== null) throw new Error('Local EVM node exited before readiness');
    try {
      const reply = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(1000) });
      if ((await reply.json()).result === '0x164ce') { ready = true; break; }
    } catch { /* only bounded startup polling */ }
    await delay(100);
  }
  assert.ok(ready, 'Local EVM did not become ready');
  const bundlePath = join(temp, 'deployment.json');
  run('corepack', ['yarn', 'hardhat', '--config', 'hardhat.stocks.config.ts', 'run', '--no-compile', 'scripts/stocks/deploy-local.ts', '--network', 'stocksLocal'],
    { cwd: contractsRoot, env: { ...process.env, STOCKS_LOCAL_RPC_PORT: String(port), STOCKS_ABI_DIGEST: ABI_DIGEST, STOCKS_MANIFEST_OUTPUT: bundlePath } });
  assert.ok(!/Private Key:|mnemonic/i.test(readFileSync(log, 'utf8')), 'Local tool unexpectedly printed account key material');
  run(pg('initdb'), ['-D', data, '-A', 'trust', '--no-locale', '-E', 'UTF8', '-U', 'stocks_local',
    '-c', 'shared_memory_type=mmap', '-c', 'dynamic_shared_memory_type=mmap', '-c', 'shared_buffers=16MB', '-c', 'max_connections=20']);
  run(pg('pg_ctl'), ['-D', data, '-l', join(temp, 'postgres.log'), '-o', `-k ${socket} -h '' -p 5432 -c shared_buffers=16MB -c max_connections=20 -c shared_memory_type=mmap -c dynamic_shared_memory_type=mmap`, '-w', 'start']);
  pgStarted = true;
  run(pg('createdb'), ['-h', socket, '-U', 'stocks_local', 'stocks_local_test']);
  for (const name of readdirSync(join(root, 'prisma/migrations')).sort().filter(name => /^\d/.test(name))) {
    run(pg('psql'), ['-h', socket, '-U', 'stocks_local', '-d', 'stocks_local_test', '-v', 'ON_ERROR_STOP=1', '-f', join(root, 'prisma/migrations', name, 'migration.sql')]);
  }
  const { runStack } = await import('./stack.mjs');
  const report = await runStack({ rpcUrl, bundle: JSON.parse(readFileSync(bundlePath, 'utf8')),
    databaseUrl: `postgresql://stocks_local@localhost/stocks_local_test?host=${encodeURIComponent(socket)}` });
  console.log(JSON.stringify(report, null, 2));
  successful = true;
} finally {
  let cleanupFailure;
  if (node?.pid && node.exitCode === null) {
    try { process.kill(-node.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') cleanupFailure = error; }
    await Promise.race([new Promise(done => node.once('exit', done)), delay(2000)]);
    if (node.exitCode === null && node.signalCode === null) {
      try { process.kill(-node.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') cleanupFailure = error; }
    }
  }
  if (pgStarted || existsSync(join(data, 'postmaster.pid'))) {
    const stop = spawnSync(pg('pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: ['ignore', fd, fd] });
    if (stop.error || stop.status !== 0 || existsSync(join(data, 'postmaster.pid'))) cleanupFailure = new Error('Owned PostgreSQL shutdown not confirmed');
  }
  closeSync(fd);
  if (cleanupFailure) throw new Error(`${cleanupFailure.message}; retained ${temp}`);
  if (successful) rmSync(temp, { recursive: true, force: true });
  else console.error(`Local test diagnostics retained at ${temp}; owned services stopped`);
}

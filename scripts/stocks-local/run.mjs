import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync, openSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { enableOwnerIntervalMining } from './startup-chain.mjs';

assert.equal(process.env.STOCKS_LOCAL_STACK_ONLY, '1', 'Explicit STOCKS_LOCAL_STACK_ONLY=1 is required');
const uiMode = process.env.STOCKS_LOCAL_UI === '1';
const browserMode = process.env.STOCKS_LOCAL_BROWSER === '1';
const ownerMode = process.env.STOCKS_LOCAL_OWNER === '1';
assert.ok(Number(uiMode) + Number(browserMode) + Number(ownerMode) + Number(process.env.STOCKS_LOCAL_STACK_CASE_PROBE === '1') + Number(process.env.STOCKS_LOCAL_STACK_SIGNAL_PROBE === '1') <= 1, 'Choose one fixed local scenario');
const root = resolve(import.meta.dirname, '../..');
const contractsRoot = join(root, 'packages/contracts');
assert.ok(existsSync(join(root, 'server/dist/stocks-runtime/observer.js')), 'Build the assembled backend/runtime first');
assert.ok(existsSync(join(contractsRoot, 'node_modules/.bin/hardhat')), 'Install existing contract dependencies first');
const temp = mkdtempSync(join(tmpdir(), 'stocks-local-stack-'));
const socket = join(temp, 'socket'); mkdirSync(socket);
const data = join(temp, 'postgres');
const log = join(temp, 'run.log'); const fd = openSync(log, 'a', 0o600);
let pgStarted = false; let postgresPid; let node;
let signalRequested;
let cleanupPromise;
let successful = false;
const resourceClosers = [];
function registerCleanup(close) {
  checkRunning();
  assert.equal(typeof close, 'function');
  assert.ok(!cleanupPromise, 'Local stack is already closing');
  resourceClosers.push(close);
}
const pg = command => process.env.STOCKS_PG_BIN ? join(process.env.STOCKS_PG_BIN, command) : command;
const checkRunning = () => { if (signalRequested) throw new Error(`Local stack stopping for ${signalRequested}`); };
const run = (command, args, options = {}) => {
  checkRunning();
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
function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    let cleanupFailure;
    // Stop UI sends/timers/API/signer before their owned DB and EVM disappear.
    for (const close of [...resourceClosers].reverse()) {
      try { await close(); } catch (error) { cleanupFailure = error; }
    }
    if (node?.pid) {
      try {
        if (groupAlive(node.pid)) process.kill(-node.pid, 'SIGTERM');
        for (let n = 0; n < 40 && groupAlive(node.pid); n++) await delay(50);
        if (groupAlive(node.pid)) process.kill(-node.pid, 'SIGKILL');
        for (let n = 0; n < 40 && groupAlive(node.pid); n++) await delay(50);
        if (groupAlive(node.pid)) throw new Error('Owned EVM process-group shutdown not confirmed');
      } catch (error) { if (error.code !== 'ESRCH') cleanupFailure = error; }
    }
    if (pgStarted || existsSync(join(data, 'postmaster.pid'))) {
      const stop = spawnSync(pg('pg_ctl'), ['-D', data, '-m', 'immediate', '-t', '10', '-w', 'stop'], { stdio: ['ignore', fd, fd] });
      if (stop.error || stop.status !== 0 || existsSync(join(data, 'postmaster.pid'))) cleanupFailure = new Error('Owned PostgreSQL shutdown not confirmed');
    }
    closeSync(fd);
    if (cleanupFailure) throw new Error(`${cleanupFailure.message}; retained ${temp}`);
    console.log(JSON.stringify({ kind: ownerMode ? 'LOCAL_OWNER_OWNED_SERVICES_STOPPED' : browserMode ? 'LOCAL_BROWSER_OWNED_SERVICES_STOPPED' : uiMode ? 'LOCAL_UI_OWNED_SERVICES_STOPPED' : 'LOCAL_STACK_OWNED_SERVICES_STOPPED',
      ownerPid: process.pid, nodeGroup: node?.pid, postgresPid, temp, postgresData: data, socket,
      postgresPidFileAbsent: !existsSync(join(data, 'postmaster.pid')),
      postgresSocketAbsent: !existsSync(join(socket, '.s.PGSQL.5432')), nodeGroupAbsent: !node?.pid || !groupAlive(node.pid) }));
    if (successful || ownerMode && signalRequested) rmSync(temp, { recursive: true, force: true });
    else console.error(`Local test diagnostics retained at ${temp}; owned services stopped`);
  })();
  return cleanupPromise;
}
function handleSignal(signal) {
  if (signalRequested) return;
  signalRequested = signal;
  // Default signal termination bypasses finally. This one cleanup promise is
  // shared with normal completion, failure, SIGINT and SIGTERM.
  void cleanup().then(() => process.exit(signal === 'SIGINT' ? 130 : 143), error => {
    console.error(error.message); process.exit(1);
  });
}
const onInterrupt = () => handleSignal('SIGINT');
const onTerminate = () => handleSignal('SIGTERM');
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);
try {
  const { ABI_DIGEST } = await import('../../server/dist/stocks/contracts.js');
  run('corepack', ['yarn', 'hardhat', '--config', 'hardhat.stocks.config.ts', 'compile'], { cwd: contractsRoot });
  const port = await freePort(); const rpcUrl = `http://127.0.0.1:${port}`;
  node = spawn('corepack', ['yarn', 'hardhat', '--config', 'hardhat.stocks.config.ts', 'node', '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd: contractsRoot, stdio: ['ignore', fd, fd], detached: true });
  let ready = false;
  for (let n = 0; n < 60; n++) {
    checkRunning();
    if (node.exitCode !== null) throw new Error('Local EVM node exited before readiness');
    try {
      const reply = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(1000) });
      if ((await reply.json()).result === '0x164ce') { ready = true; break; }
    } catch { /* only bounded startup polling */ }
    await delay(100);
  }
  assert.ok(ready, 'Local EVM did not become ready');
  if (ownerMode) {
    // rpcUrl is the loopback port of our newly spawned child, never user input.
    // The interval belongs to that child and ends with existing process cleanup.
    await enableOwnerIntervalMining(async (method, params) => {
      checkRunning();
      const response = await fetch(rpcUrl, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      assert.ok(response.ok, 'Owner mining RPC unavailable');
      const row = await response.json();
      assert.equal(row.id, 1); assert.ok(!row.error, 'Owner mining RPC rejected');
      return row.result;
    });
  }
  const bundlePath = join(temp, 'deployment.json');
  run('corepack', ['yarn', 'hardhat', '--config', 'hardhat.stocks.config.ts', 'run', '--no-compile', 'scripts/stocks/deploy-local.ts', '--network', 'stocksLocal'],
    { cwd: contractsRoot, env: { ...process.env, STOCKS_LOCAL_RPC_PORT: String(port), STOCKS_ABI_DIGEST: ABI_DIGEST, STOCKS_MANIFEST_OUTPUT: bundlePath } });
  assert.ok(!/Private Key:|mnemonic/i.test(readFileSync(log, 'utf8')), 'Local tool unexpectedly printed account key material');
  run(pg('initdb'), ['-D', data, '-A', 'trust', '--no-locale', '-E', 'UTF8', '-U', 'stocks_local',
    '-c', 'shared_memory_type=mmap', '-c', 'dynamic_shared_memory_type=mmap', '-c', 'shared_buffers=16MB', '-c', 'max_connections=20']);
  run(pg('pg_ctl'), ['-D', data, '-l', join(temp, 'postgres.log'), '-o', `-k ${socket} -h '' -p 5432 -c shared_buffers=16MB -c max_connections=20 -c shared_memory_type=mmap -c dynamic_shared_memory_type=mmap`, '-w', 'start']);
  pgStarted = true;
  postgresPid = Number(readFileSync(join(data, 'postmaster.pid'), 'utf8').split('\n')[0]);
  run(pg('createdb'), ['-h', socket, '-U', 'stocks_local', 'stocks_local_test']);
  for (const name of readdirSync(join(root, 'prisma/migrations')).sort().filter(name => /^\d/.test(name))) {
    run(pg('psql'), ['-h', socket, '-U', 'stocks_local', '-d', 'stocks_local_test', '-v', 'ON_ERROR_STOP=1', '-f', join(root, 'prisma/migrations', name, 'migration.sql')]);
  }
  if (process.env.STOCKS_LOCAL_STACK_SIGNAL_PROBE === '1') {
    console.log(JSON.stringify({ kind: 'LOCAL_STACK_SERVICES_READY', ownerPid: process.pid,
      nodeGroup: node.pid, postgresPid: Number(readFileSync(join(data, 'postmaster.pid'), 'utf8').split('\n')[0]),
      postgresData: data, socket, temp }));
    await new Promise(() => {}); // Signal-check child deliberately awaits its owned cleanup.
  }
  // Fixed local regression selection only; never accept an arbitrary module path.
  const { runStack } = await import(ownerMode ? './owner-run.mjs' : browserMode ? './browser-run.mjs' : uiMode ? './ui-run.mjs' : process.env.STOCKS_LOCAL_STACK_CASE_PROBE === '1' ? './address-case.mjs' : './stack.mjs');
  checkRunning();
  const report = await runStack({ rpcUrl, bundle: JSON.parse(readFileSync(bundlePath, 'utf8')),
    databaseUrl: `postgresql://stocks_local@localhost/stocks_local_test?host=${encodeURIComponent(socket)}`, resourceDir: temp, registerCleanup });
  console.log(JSON.stringify(report, null, 2));
  if (!uiMode && !browserMode && !ownerMode) console.log(JSON.stringify({ kind: 'LOCAL_STACK_RESULT', ...report }));
  successful = true;
} finally {
  await cleanup();
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onTerminate);
}

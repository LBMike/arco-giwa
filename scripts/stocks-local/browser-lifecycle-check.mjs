// Explicit disposable local-browser harness only. Inspect and stop only child-owned resources.
// Run after the browser runner is ready; no public network, installed user browser, existing DB or wallet.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

assert.equal(process.env.STOCKS_LOCAL_STACK_ONLY, '1');
const root = resolve(import.meta.dirname, '../..');
function pid(value) {
  assert.ok(Number.isSafeInteger(value) && value > 1, 'Owned process id is required');
  return value;
}
function alive(value, group = false) {
  try { process.kill(group ? -pid(value) : pid(value), 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function listening(base) {
  const url = new URL(base);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.protocol, 'http:');
  assert.ok(Number.isSafeInteger(Number(url.port)) && Number(url.port) > 0 && Number(url.port) <= 65535);
  return new Promise(done => {
    const socket = connect({ host: '127.0.0.1', port: Number(url.port) });
    let settled = false;
    const finish = value => { if (settled) return; settled = true; socket.destroy(); done(value); };
    socket.setTimeout(1000);
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
  });
}

for (const mode of ['ready-SIGINT', 'held-SIGTERM', 'failure']) {
  const probe = mode === 'failure' ? 'failure' : mode === 'held-SIGTERM' ? 'held' : 'ready';
  const child = spawn(process.execPath, ['scripts/stocks-local/run.mjs'], {
    cwd: root,
    env: { ...process.env, STOCKS_LOCAL_BROWSER: '1', STOCKS_LOCAL_BROWSER_PROBE: probe, STOCKS_LOCAL_BROWSER_CASE: '',
      STOCKS_LOCAL_UI: '', STOCKS_LOCAL_UI_FAILURE_PROBE: '', STOCKS_LOCAL_STACK_CASE_PROBE: '', STOCKS_LOCAL_STACK_SIGNAL_PROBE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready, held, resources, stopped, failure, signalled = false, stdout = '', stderr = '', pending = '';
  const signal = mode === 'ready-SIGINT' ? 'SIGINT' : 'SIGTERM';
  const timer = setTimeout(() => {
    failure = new Error(`${mode}: owned browser lifecycle child exceeded 180 seconds`);
    child.kill('SIGTERM');
  }, 180000);
  child.stdout.on('data', chunk => {
    stdout += chunk; pending += chunk;
    const lines = pending.split('\n'); pending = lines.pop();
    for (const line of lines) {
      try {
        if (line.startsWith('{')) {
          const record = JSON.parse(line);
          if (record.kind === 'LOCAL_BROWSER_READY') ready = record;
          if (record.kind === 'LOCAL_BROWSER_HELD') held = record;
          if (record.kind === 'LOCAL_BROWSER_RESOURCES_STOPPED') resources = record;
          if (record.kind === 'LOCAL_BROWSER_OWNED_SERVICES_STOPPED') stopped = record;
        }
        const trigger = mode === 'ready-SIGINT' ? Boolean(ready) : mode === 'held-SIGTERM' && Boolean(ready && held);
        if (trigger && !signalled) { signalled = true; assert.equal(child.kill(signal), true, 'Owned child accepted stop signal'); }
      } catch (error) { failure = error; child.kill('SIGTERM'); }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  let result;
  try {
    result = await new Promise((done, fail) => {
      child.once('error', fail); child.once('close', (code, killedBy) => done({ code, killedBy }));
    });
  } finally { clearTimeout(timer); }
  // Retain all owned-child diagnostics even when shutdown assertions fail.
  const artifacts = process.env.STOCKS_LOCAL_BROWSER_EVIDENCE;
  if (artifacts) {
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, `${mode}.stdout.log`), stdout, { mode: 0o600 });
    writeFileSync(join(artifacts, `${mode}.stderr.log`), stderr, { mode: 0o600 });
    writeFileSync(join(artifacts, `${mode}.lifecycle.json`), JSON.stringify({ mode, childPid: child.pid, result, ready, held, resources, stopped, signalled, failure: failure?.message }, null, 2) + '\n', { mode: 0o600 });
  }
  if (failure) throw failure;
  assert.ok(ready && resources && stopped, `${mode}: missing owned browser resource evidence; result=${JSON.stringify(result)}; ready=${Boolean(ready)} resources=${Boolean(resources)} stopped=${Boolean(stopped)}; ${stderr.slice(-1800)}`);
  assert.equal(ready.ownerPid, child.pid); assert.equal(stopped.ownerPid, child.pid);
  assert.equal(result.code, mode === 'failure' ? 1 : signal === 'SIGINT' ? 130 : 143, stderr.slice(-1800));
  assert.equal(result.killedBy, null, 'Runner must finish its own cleanup and select its exit code');
  assert.equal(signalled, mode !== 'failure');
  if (mode === 'held-SIGTERM') assert.ok(held, 'Actual held provider response reached before SIGTERM');
  assert.equal(resources.chromePid, ready.chromePid);
  assert.equal(resources.chromeExited, true); assert.equal(resources.bridgeClosed, true); assert.equal(resources.apiClosed, true);
  assert.equal(stopped.postgresPidFileAbsent, true); assert.equal(stopped.postgresSocketAbsent, true); assert.equal(stopped.nodeGroupAbsent, true);
  // Independently check the OS and sockets instead of treating runner booleans as proof.
  assert.equal(alive(ready.chromePid), false, 'Owned Chrome process exited');
  assert.equal(alive(child.pid), false, 'Owned runner exited');
  assert.equal(alive(stopped.nodeGroup, true), false, 'Owned local EVM process group exited');
  assert.equal(alive(stopped.postgresPid), false, 'Owned PostgreSQL process exited');
  assert.equal(existsSync(join(stopped.postgresData, 'postmaster.pid')), false);
  assert.equal(existsSync(join(stopped.socket, '.s.PGSQL.5432')), false);
  assert.equal(await listening(ready.apiBase), false, 'Owned API port closed');
  assert.equal(await listening(ready.origin), false, 'Owned browser bridge/Vite port closed');
  assert.equal(await listening(ready.rpcUrl), false, 'Owned local RPC port closed');
  assert.ok(!/Private Key:|mnemonic/i.test(stdout + stderr), 'No key material in child diagnostics');
  assert.ok(/^\/(?:private\/)?tmp\/stocks-local-stack-[A-Za-z0-9_-]+$/.test(stopped.temp), 'Only child-owned temporary stack directory may be removed');
  assert.equal(resolve(stopped.postgresData), join(stopped.temp, 'postgres'));
  assert.equal(resolve(stopped.socket), join(stopped.temp, 'socket'));
  rmSync(stopped.temp, { recursive: true, force: true });
  console.log(JSON.stringify({ kind: 'LOCAL_BROWSER_LIFECYCLE_PASS', mode, ...result, ownerPid: child.pid,
    chromePid: ready.chromePid, chromeExited: true, apiClosed: true, bridgeClosed: true, rpcClosed: true,
    nodeGroup: stopped.nodeGroup, nodeGroupAbsent: true, postgresPid: stopped.postgresPid, postgresPidFileAbsent: true, pgSocketAbsent: true }));
}

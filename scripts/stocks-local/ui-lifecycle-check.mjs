// Execute only against child-owned disposable services. Never discover or stop an existing service.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { assertPortClosed } from './assert-port-closed.mjs';
import { existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

assert.equal(process.env.STOCKS_LOCAL_STACK_ONLY, '1');
const root = resolve(import.meta.dirname, '../..');
function alive(pid, group = false) {
  try { process.kill(group ? -pid : pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

for (const mode of ['ready-SIGINT', 'active-SIGTERM', 'failure']) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/stocks-local/run.mjs'], { cwd: root,
    env: { ...process.env, STOCKS_LOCAL_UI: '1', STOCKS_LOCAL_STACK_CASE_PROBE: '', STOCKS_LOCAL_STACK_SIGNAL_PROBE: '',
      STOCKS_LOCAL_UI_FAILURE_PROBE: mode === 'failure' ? '1' : '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let ready, stopped, signalled = false, failure, stdout = '', stderr = '', pending = '';
  const timer = setTimeout(() => { failure = new Error('Owned lifecycle child timed out'); child.kill('SIGTERM'); }, 120000);
  const signal = mode.endsWith('SIGINT') ? 'SIGINT' : 'SIGTERM';
  child.stdout.on('data', chunk => {
    stdout += chunk; pending += chunk;
    const lines = pending.split('\n'); pending = lines.pop();
    for (const line of lines) {
      try {
        if (line.startsWith('{')) {
          const record = JSON.parse(line);
          if (record.kind === 'LOCAL_UI_READY') ready = record;
          if (record.kind === 'LOCAL_UI_OWNED_SERVICES_STOPPED') stopped = record;
        }
        const trigger = mode === 'ready-SIGINT' ? Boolean(ready) : mode === 'active-SIGTERM' && line.startsWith('STOCKS_LOCAL_UI_STEP ');
        if (trigger && !signalled) { signalled = true; child.kill(signal); }
      } catch (error) { failure = error; child.kill('SIGTERM'); }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const result = await new Promise((done, fail) => { child.once('error', fail); child.once('close', (code, killedBy) => done({ code, killedBy })); });
  clearTimeout(timer);
  if (failure) throw failure;
  assert.ok(ready && stopped, `${mode}: missing owned resource evidence: ${stderr.slice(-1500)}`);
  assert.equal(ready.ownerPid, child.pid); assert.equal(stopped.ownerPid, child.pid);
  assert.equal(result.code, mode === 'failure' ? 1 : signal === 'SIGINT' ? 130 : 143, stderr.slice(-1500));
  assert.equal(result.killedBy, null);
  assert.equal(alive(stopped.nodeGroup, true), false); assert.equal(alive(stopped.postgresPid), false);
  assert.equal(existsSync(join(stopped.postgresData, 'postmaster.pid')), false);
  assert.equal(existsSync(join(stopped.socket, '.s.PGSQL.5432')), false);
  await assertPortClosed(ready.apiBase); await assertPortClosed(ready.rpcUrl);
  assert.ok(!/Private Key:|mnemonic/i.test(stdout + stderr));
  assert.ok(stopped.temp.startsWith('/private/tmp/stocks-local-stack-') || stopped.temp.startsWith('/tmp/stocks-local-stack-'));
  rmSync(stopped.temp, { recursive: true, force: true });
  console.log(JSON.stringify({ kind: 'LOCAL_UI_LIFECYCLE_PASS', mode, ...result, apiClosed: true, rpcClosed: true,
    nodeGroup: stopped.nodeGroup, postgresPid: stopped.postgresPid, pgSocketAbsent: true }));
}

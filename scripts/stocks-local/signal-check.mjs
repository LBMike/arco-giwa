import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

assert.equal(process.env.STOCKS_LOCAL_STACK_ONLY, '1');
const root = resolve(import.meta.dirname, '../..');
function exists(pid, group = false) {
  try { process.kill(group ? -pid : pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
for (const signal of ['SIGTERM', 'SIGINT']) {
  const child = spawn(process.execPath, ['scripts/stocks-local/run.mjs'], { cwd: root,
    env: { ...process.env, STOCKS_LOCAL_STACK_SIGNAL_PROBE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let ready; let stdout = ''; let stderr = ''; let callbackFailure;
  const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
  child.stdout.on('data', chunk => {
    stdout += chunk;
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const value = JSON.parse(line);
        if (!ready && value.kind === 'LOCAL_STACK_SERVICES_READY') {
          ready = value;
          assert.equal(value.ownerPid, child.pid);
          assert.ok(exists(value.nodeGroup, true) && exists(value.postgresPid));
          child.kill(signal);
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) { callbackFailure = error; child.kill('SIGTERM'); }
      }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const result = await new Promise((done, fail) => { child.once('error', fail); child.once('close', (code, killedBy) => done({ code, killedBy })); });
  clearTimeout(timer);
  if (callbackFailure) throw callbackFailure;
  assert.ok(ready, `${signal}: services did not reach readiness: ${stderr.slice(-1500)}`);
  assert.equal(result.code, signal === 'SIGINT' ? 130 : 143, stderr.slice(-1500));
  assert.equal(result.killedBy, null, 'Runner must exit after cleanup, not via default signal termination');
  assert.equal(exists(ready.nodeGroup, true), false, 'Owned EVM process group remains alive');
  assert.equal(exists(ready.postgresPid), false, 'Owned PostgreSQL remains alive');
  assert.equal(existsSync(join(ready.postgresData, 'postmaster.pid')), false);
  assert.equal(existsSync(join(ready.socket, '.s.PGSQL.5432')), false);
  assert.ok(!/Private Key:|mnemonic/i.test(stdout + stderr));
  rmSync(ready.temp, { recursive: true, force: true });
  console.log(`PASS ${signal}: owned EVM group, PostgreSQL and socket stopped before runner exit`);
}

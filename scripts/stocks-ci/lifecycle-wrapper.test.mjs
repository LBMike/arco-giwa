import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const source = resolve(import.meta.dirname, '../stocks-local/browser-lifecycle-check.mjs');
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
async function until(predicate, milliseconds = 5000) {
  const deadline = Date.now() + milliseconds;
  while (!predicate() && Date.now() < deadline) await delay(10);
  return predicate();
}

// These fixtures validate wrapper signal forwarding and evidence retention only.
// No PostgreSQL, Chrome, wallet, EVM, or network socket is started. The fake
// runner deliberately emits no service-ready/PASS records, so interruption is
// never confused with completing any real lifecycle scenario.
for (const signal of ['SIGINT', 'SIGTERM']) test(`lifecycle wrapper forwards ${signal}, waits for its child, and starts no next case`, { timeout: 20000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'stocks-lifecycle-wrapper-'));
  const scripts = join(root, 'scripts/stocks-local');
  const evidence = join(root, 'evidence');
  const readyFile = join(root, 'fake-child-ready.json');
  const journal = join(root, 'fake-starts.jsonl');
  const cleanupFile = join(root, 'fake-cleanup-complete.json');
  mkdirSync(scripts, { recursive: true });
  copyFileSync(source, join(scripts, 'browser-lifecycle-check.mjs'));
  copyFileSync(resolve(import.meta.dirname, '../stocks-local/assert-port-closed.mjs'), join(scripts, 'assert-port-closed.mjs'));
  writeFileSync(join(scripts, 'run.mjs'), `
import { appendFileSync, writeFileSync } from 'node:fs';
let stopping = false;
const timer = setInterval(() => {}, 1000);
process.on('SIGTERM', () => {
  if (stopping) return;
  stopping = true;
  console.log('FAKE_CLEANUP_STARTED');
  setTimeout(() => {
    clearInterval(timer);
    writeFileSync(process.env.FIXTURE_CLEANUP, JSON.stringify({ pid: process.pid, received: 'SIGTERM' }));
    process.stdout.write('FAKE_CLEANUP_COMPLETE\\n', () => process.exit(143));
  }, 100);
});
const identity = { pid: process.pid, probe: process.env.STOCKS_LOCAL_BROWSER_PROBE };
appendFileSync(process.env.FIXTURE_JOURNAL, JSON.stringify(identity) + '\\n');
// Publish readiness only after installing the handler; the parent never races
// a default signal action or uses an arbitrary startup delay.
writeFileSync(process.env.FIXTURE_READY, JSON.stringify(identity));
`);
  const checker = spawn(process.execPath, [join(scripts, 'browser-lifecycle-check.mjs')], {
    cwd: root,
    env: {
      STOCKS_LOCAL_STACK_ONLY: '1', STOCKS_LOCAL_BROWSER_EVIDENCE: evidence,
      FIXTURE_READY: readyFile, FIXTURE_JOURNAL: journal, FIXTURE_CLEANUP: cleanupFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', outcome, spawnError, ownedChildPid;
  checker.stdout.on('data', chunk => { stdout += chunk; });
  checker.stderr.on('data', chunk => { stderr += chunk; });
  checker.once('error', error => { spawnError = error; });
  checker.once('close', (code, killedBy) => { outcome = { code, killedBy }; });
  try {
    assert.equal(await until(() => existsSync(readyFile) || !!outcome || !!spawnError), true, 'Fake child must become ready within the bound');
    assert.equal(spawnError, undefined);
    assert.equal(outcome, undefined, stderr);
    const ready = JSON.parse(readFileSync(readyFile, 'utf8'));
    ownedChildPid = ready.pid;
    assert.ok(Number.isSafeInteger(ownedChildPid) && ownedChildPid > 1);
    assert.equal(ready.probe, 'ready');
    assert.equal(alive(ownedChildPid), true);
    assert.equal(checker.kill(signal), true);
    assert.equal(await until(() => !!outcome), true, 'Wrapper must finish after its child cleanup');
    assert.deepEqual(outcome, { code: signal === 'SIGINT' ? 130 : 143, killedBy: null });
    assert.equal(alive(ownedChildPid), false, 'Wrapper close must follow its owned child exit');
    assert.deepEqual(JSON.parse(readFileSync(cleanupFile, 'utf8')), { pid: ownedChildPid, received: 'SIGTERM' });
    const starts = readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(starts, [{ pid: ownedChildPid, probe: 'ready' }], 'No subsequent lifecycle case may start');
    assert.deepEqual(readdirSync(evidence).sort(), ['ready-SIGINT.lifecycle.json', 'ready-SIGINT.stderr.log', 'ready-SIGINT.stdout.log']);
    const record = JSON.parse(readFileSync(join(evidence, 'ready-SIGINT.lifecycle.json'), 'utf8'));
    assert.equal(record.childPid, ownedChildPid);
    assert.equal(record.interrupted, signal);
    assert.equal(record.signalled, false, 'External interruption must not masquerade as the scenario signal');
    assert.deepEqual(record.result, { code: 143, killedBy: null });
    const childOutput = readFileSync(join(evidence, 'ready-SIGINT.stdout.log'), 'utf8');
    assert.match(childOutput, /FAKE_CLEANUP_STARTED\nFAKE_CLEANUP_COMPLETE\n/);
    assert.doesNotMatch(stdout + stderr + childOutput, /LOCAL_BROWSER_LIFECYCLE_PASS/);
  } finally {
    // Only this fixture's checker and the PID recorded by its own fake child
    // may be stopped, including when an assertion above fails.
    if (!outcome) {
      checker.kill('SIGTERM');
      if (!await until(() => !!outcome, 1000)) {
        checker.kill('SIGKILL');
        await until(() => !!outcome, 1000);
      }
    }
    if (!ownedChildPid && existsSync(readyFile)) ownedChildPid = JSON.parse(readFileSync(readyFile, 'utf8')).pid;
    if (Number.isSafeInteger(ownedChildPid) && ownedChildPid > 1 && alive(ownedChildPid)) {
      process.kill(ownedChildPid, 'SIGKILL');
      await until(() => !alive(ownedChildPid), 1000);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

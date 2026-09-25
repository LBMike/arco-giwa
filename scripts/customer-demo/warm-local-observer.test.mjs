import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('observer preparation requires its explicit fixed action before private configuration or network use', () => {
  const script = fileURLToPath(new URL('./warm-local-observer.mjs', import.meta.url));
  const marker = 'SYNTHETIC_INPUT_MUST_NOT_BE_LOGGED';
  for (const args of [[], ['--check'], ['--prepare-observer', marker]]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH, DATABASE_URL: marker }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), { status: 'LOCAL_OBSERVER_PREPARATION_FAILED', stage: 'CONFIGURATION', code: 'UNAVAILABLE' });
    assert.ok(!result.stderr.includes(marker));
  }
});

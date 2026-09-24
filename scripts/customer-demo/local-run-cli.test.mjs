import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('actual local runner refuses non-TTY execution before reading configuration or wallet and never echoes input',()=>{
  const result=spawnSync(process.execPath,['scripts/customer-demo/run-local-customer.mjs'],{
    cwd:new URL('../../',import.meta.url),encoding:'utf8',timeout:15000,input:'synthetic-sensitive-input\n',
    env:{PATH:process.env.PATH,HOME:process.env.HOME},
  });
  assert.equal(result.status,1);
  assert.match(result.stderr,/LOCAL_DEMO_START_FAILED \[LOCAL_CONFIGURATION\]/);
  assert.doesNotMatch(result.stdout+result.stderr,/synthetic-sensitive-input|postgresql:\/\/|0x3185/);
});

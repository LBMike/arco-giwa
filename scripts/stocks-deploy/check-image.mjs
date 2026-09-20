// Build is separate. This check starts only the supplied LOCAL image without
// external networking, published ports, real credentials, DBs or chain access.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const [image = 'arco-giwa-api:local', ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0);
assert.match(image, /^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,200}$/);
function docker(args, allowFailure = false) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024 });
  if (!allowFailure && (result.error || result.status !== 0)) throw Error('CONTAINER_CHECK_COMMAND_FAILED');
  return result;
}
const owned = new Set();
const fixture = [
  'DATABASE_URL=postgresql://fixture:fixture@127.0.0.1:9/fixture',
  'DIRECT_URL=postgresql://fixture:fixture@127.0.0.1:9/fixture',
  'INDEXER_RPC_URL=https://rpc.invalid',
  'AUTH_JWT_SECRET=TEST_CONTAINER_ONLY_SESSION_NOT_A_REAL_SECRET',
  'ADMIN_OPERATOR_TOKEN=TEST_CONTAINER_ONLY_NOT_A_REAL_TOKEN',
  'CORS_ALLOWED_ORIGINS=https://ui.invalid',
];
function start(env) {
  const name = `stocks-image-check-${randomUUID()}`;
  owned.add(name);
  docker(['run', '--detach', '--pull=never', '--name', name, '--network', 'none', '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    ...env.flatMap(value => ['--env', value]), image]);
  return name;
}
function inspect(name) { return JSON.parse(docker(['inspect', name]).stdout)[0]; }
try {
  const config = JSON.parse(docker(['image', 'inspect', image]).stdout)[0].Config;
  assert.equal(config.User, 'node');
  assert.deepEqual(config.Cmd, ['node', 'server/dist/index.js']);
  assert.ok(config.Env.includes('STOCKS_MODE=DISABLED'));
  assert.ok(config.Env.includes('STOCKS_AUTODISPATCH=0'));
  assert.equal(config.StopSignal, 'SIGTERM');
  const running = start(fixture);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const check = docker(['exec', running, 'node', 'scripts/stocks-deploy/healthcheck.mjs'], true);
    if (check.status === 0) { ready = true; break; }
    assert.equal(inspect(running).State.Running, true, 'API exited before liveness');
    await delay(250);
  }
  assert.ok(ready, 'API liveness deadline exceeded');
  docker(['exec', running, 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    import { PrismaClient } from '@prisma/client';
    assert.equal(typeof PrismaClient, 'function');
    assert.notEqual(process.getuid(), 0);
    for (const file of ['server/src', '.git', '.env', '.secrets', 'review-results', 'scripts/stocks-local', 'dist'])
      assert.equal(existsSync(file), false, file);
    for (const path of ['/api/v1/stocks/orders', '/api/v1/admin/stocks/runtime', '/ready/stocks']) {
      const response = await fetch('http://127.0.0.1:8080' + path);
      assert.equal(response.status, 404);
    }
  `]);
  docker(['exec', running, 'node', 'scripts/stocks-preflight/run.mjs', '--help']);
  docker(['stop', '--time', '15', running]);
  assert.equal(inspect(running).State.ExitCode, 0, 'SIGTERM must drain and exit normally');
  for (const env of [[], [...fixture, 'STOCKS_MODE=DEMO_TESTNET']]) {
    const failing = start(env);
    assert.equal(docker(['wait', failing]).stdout.trim(), '1');
    const logs = docker(['logs', failing]);
    assert.equal((logs.stdout + logs.stderr).trim(), 'SERVER_START_FAILED');
  }
  console.log('STOCKS_CONTAINER_CHECK_PASS: non-root, read-only, network-disabled startup; fixed failures; SIGTERM cleanup');
} finally {
  const failures = [];
  for (const name of owned) if (docker(['rm', '--force', name], true).status !== 0) failures.push(name);
  assert.deepEqual(failures, [], 'Owned container cleanup failed');
}

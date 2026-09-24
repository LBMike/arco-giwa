import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { localCustomerEnvironment, readLocalCustomerServerConfig, createLocalCustomerServerConfig } from './local-environment.mjs';

const config = () => ({
  DATABASE_URL: 'postgresql://postgres.munsybkrsxrmajmbssli:TEST_ONLY@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres',
  DIRECT_URL: 'postgresql://postgres:TEST_ONLY@db.munsybkrsxrmajmbssli.supabase.co:5432/postgres',
  AUTH_JWT_SECRET: 'a'.repeat(64), ADMIN_OPERATOR_TOKEN: 'b'.repeat(64), STOCKS_SIGNER_TOKEN: 'c'.repeat(64),
});
test('local environment confines server credentials and drops inherited frontend, options, custody and unrelated secrets', () => {
  const input = config();
  const env = localCustomerEnvironment(input, '/public/runtime.json', { PATH: '/bin', PRIVATE_KEY: 'DONT_COPY',
    NODE_OPTIONS: '--require=untrusted', VITE_DYNAMIC_ENVIRONMENT_ID: 'DONT_COPY', DATABASE_URL: 'WRONG_DATABASE' });
  assert.equal(env.DATABASE_URL, input.DATABASE_URL);
  assert.equal(env.PORT, '4393'); assert.equal(env.CORS_ALLOWED_ORIGINS, 'http://127.0.0.1:4392');
  assert.equal(env.STOCKS_CONFIG_PATH, '/public/runtime.json');
  assert.doesNotMatch(JSON.stringify(env), /DONT_COPY|untrusted|WRONG_DATABASE|VITE_/);
  for (const invalid of [{ ...input, PRIVATE_KEY: 'NEVER_PRINT' }, { ...input, AUTH_JWT_SECRET: 'weak' },
    { ...input, DATABASE_URL: input.DATABASE_URL.replace('munsybkrsxrmajmbssli', 'other') }]) {
    assert.throws(() => localCustomerEnvironment(invalid, '/public/runtime.json'), { message: 'LOCAL_CUSTOMER_SERVER_CONFIGURATION_UNAVAILABLE' });
  }
});
test('setup generates distinct local credentials and rejects a foreign destination before writing', () => {
  const first = createLocalCustomerServerConfig(config().DATABASE_URL), second = createLocalCustomerServerConfig(config().DATABASE_URL);
  assert.equal(first.DIRECT_URL, first.DATABASE_URL);
  for (const key of ['AUTH_JWT_SECRET', 'ADMIN_OPERATOR_TOKEN', 'STOCKS_SIGNER_TOKEN']) {
    assert.match(first[key], /^[0-9a-f]{64}$/); assert.notEqual(first[key], second[key]);
  }
  assert.equal(new Set([first.AUTH_JWT_SECRET, first.ADMIN_OPERATOR_TOKEN, first.STOCKS_SIGNER_TOKEN]).size, 3);
  assert.throws(() => createLocalCustomerServerConfig(config().DATABASE_URL + '?host=foreign.example'));
  const result = spawnSync(process.execPath, ['scripts/customer-demo/setup-server.mjs', '--output', '/NEVER_PRINT/server.json'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1); assert.doesNotMatch(result.stdout + result.stderr, /NEVER_PRINT|postgresql:\/\//);
});
test('explicit private config rejects symlinks, unsafe permissions and malformed input with fixed diagnostics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'giwa-local-env-'));
  try {
    const file = join(dir, 'server.json');
    await writeFile(file, JSON.stringify(config()), { mode: 0o600 });
    assert.deepEqual(await readLocalCustomerServerConfig(file), config());
    const link = join(dir, 'link.json'); await symlink(file, link);
    await assert.rejects(readLocalCustomerServerConfig(link), /LOCAL_CUSTOMER_SERVER_CONFIGURATION_UNAVAILABLE/);
    await chmod(file, 0o644);
    await assert.rejects(readLocalCustomerServerConfig(file), /LOCAL_CUSTOMER_SERVER_CONFIGURATION_UNAVAILABLE/);
    await chmod(file, 0o600); await writeFile(file, 'NEVER_PRINT');
    await assert.rejects(readLocalCustomerServerConfig(file), { message: 'LOCAL_CUSTOMER_SERVER_CONFIGURATION_UNAVAILABLE' });
    const fifo = join(dir, 'pipe');
    const created = spawnSync('mkfifo', [fifo], { timeout: 1000 });
    assert.equal(created.status, 0);
    await assert.rejects(readLocalCustomerServerConfig(fifo), { message: 'LOCAL_CUSTOMER_SERVER_CONFIGURATION_UNAVAILABLE' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('local launcher invalid inputs do not disclose paths or inherited secrets', () => {
  const result = spawnSync(process.execPath, ['scripts/customer-demo/local-api.mjs', '--token', 'NEVER_PRINT'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, DATABASE_URL: 'NEVER_PRINT' }, timeout: 10000,
  });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'LOCAL_CUSTOMER_API_START_FAILED\n');
});

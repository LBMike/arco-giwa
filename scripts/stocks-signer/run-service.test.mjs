import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { testManifest } from '../../server/dist/stocks/test-fixtures.js';
import { manifestDigest } from '../../server/dist/stocks/contracts.js';

const root = resolve(import.meta.dirname, '../..');
const token = randomBytes(32).toString('hex');
function run(args, env) {
  return spawnSync(process.execPath, ['scripts/stocks-signer/run-service.mjs', ...args], {
    cwd: root, encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, NODE_OPTIONS: '', ...env } });
}

test('hosted launcher validates arguments and refuses key or password environment variables before reading files', () => {
  const bad = run(['--config', 'relative.json', '--keystore', '/k', '--password-file', '/p', '--serve'], {});
  assert.equal(bad.status, 1); assert.equal(bad.stdout, ''); assert.equal(bad.stderr, 'SIGNER_SERVICE_START_FAILED stage=ARGUMENTS\n');
  const env = run(['--config', '/missing-config.json', '--keystore', '/missing-keystore.json', '--password-file', '/missing-password', '--serve'],
    { STOCKS_SIGNER_KEYSTORE_PASSWORD: 'SYNTHETIC_FORBIDDEN_INPUT', STOCKS_SIGNER_DATABASE_URL: 'postgresql://unused@127.0.0.1:1/unused', STOCKS_SIGNER_TOKEN: token });
  assert.equal(env.status, 1); assert.equal(env.stderr, 'SIGNER_SERVICE_START_FAILED stage=ENVIRONMENT\n');
  assert.doesNotMatch(env.stderr + env.stdout, /SYNTHETIC_FORBIDDEN_INPUT|missing-/);
  const noToken = run(['--config', '/missing-config.json', '--keystore', '/k', '--password-file', '/p', '--check'],
    { STOCKS_SIGNER_DATABASE_URL: 'postgresql://unused@127.0.0.1:1/unused', STOCKS_SIGNER_TOKEN: 'short' });
  assert.equal(noToken.stderr, 'SIGNER_SERVICE_START_FAILED stage=ENVIRONMENT\n');
});

test('hosted launcher unlocks only through a private copy, removes it, and never echoes the password', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'giwa-signer-service-'));
  const scratch = mkdtempSync(join(tmpdir(), 'giwa-signer-scratch-'));
  try {
    const requireContracts = createRequire(new URL('../../packages/contracts/package.json', import.meta.url));
    const { Wallet } = requireContracts('ethers');
    const wallet = Wallet.createRandom();
    const password = `SYNTHETIC-${randomBytes(12).toString('hex')}`;
    const manifest = { ...testManifest(), signerAddress: wallet.address.toLowerCase() };
    const base = { schemaVersion: 1, profile: 'DEMO_TESTNET', manifest, reviewedManifestDigest: manifestDigest(manifest),
      reviewedInitialNonce: '0', rpcUrl: 'https://sepolia-rpc.giwa.io', listen: { host: '0.0.0.0', port: 4394 },
      custody: { type: 'SECRET_FILE_KEYSTORE', exclusiveAccountControlConfirmed: true },
      transaction: { gas: '1000000', maxFeePerGas: '1000000', maxPriorityFeePerGas: '1000' },
      limits: { maxGas: '2000000', maxFeePerGas: '1000000', maxTotalFeeWei: '2000000000000' } };
    const configPath = join(dir, 'config.json'), localConfigPath = join(dir, 'local-config.json');
    const keyPath = join(dir, 'keystore.json'), passwordPath = join(dir, 'password'), wrongPath = join(dir, 'wrong');
    writeFileSync(configPath, JSON.stringify(base));
    writeFileSync(localConfigPath, JSON.stringify({ ...base, listen: { host: '127.0.0.1', port: 4394 }, custody: { type: 'LOCAL_KEYSTORE', exclusiveAccountControlConfirmed: true } }));
    // A platform mount is typically world-readable; the launcher must still accept it.
    writeFileSync(keyPath, await wallet.encrypt(password, { scrypt: { N: 16384 } }), { mode: 0o444 });
    writeFileSync(passwordPath, `${password}\n`, { mode: 0o444 });
    writeFileSync(wrongPath, 'SYNTHETIC-wrong\n', { mode: 0o444 });
    const env = { TMPDIR: scratch, STOCKS_SIGNER_DATABASE_URL: 'postgresql://unused@127.0.0.1:1/unused', STOCKS_SIGNER_TOKEN: token };
    const local = run(['--config', localConfigPath, '--keystore', keyPath, '--password-file', passwordPath, '--check'], env);
    assert.equal(local.stderr, 'SIGNER_SERVICE_START_FAILED stage=CONFIG\n');
    const wrong = run(['--config', configPath, '--keystore', keyPath, '--password-file', wrongPath, '--check'], env);
    assert.equal(wrong.stderr, 'SIGNER_SERVICE_START_FAILED stage=KEYSTORE\n');
    // The right password unlocks; the unreachable journal then stops the host before it listens.
    const right = run(['--config', configPath, '--keystore', keyPath, '--password-file', passwordPath, '--check'], env);
    assert.equal(right.status, 1); assert.equal(right.stdout, '');
    assert.match(right.stderr, /^(SIGNER_DATABASE_CONNECTION_ERROR\n)*SIGNER_SERVICE_START_FAILED stage=HOST_START\n$/);
    for (const output of [local, wrong, right]) assert.doesNotMatch(output.stdout + output.stderr, /SYNTHETIC|password:/);
    // Only the launcher's private keystore copies are checked (ts-node may keep its own compile cache there).
    assert.deepEqual(readdirSync(scratch).filter(name => name.startsWith('arco-signer-')), []);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); }
});

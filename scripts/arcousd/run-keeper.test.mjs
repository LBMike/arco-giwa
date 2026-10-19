import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

// The keeper launcher: argument and environment refusals, fail-closed settings, and the live
// keystore unlock through platform secret files (a throwaway key; the RPC is unreachable on
// purpose, so getting to stage=RPC proves the unlock passed and nothing could be sent).
const root = resolve(import.meta.dirname, '../..');
const NO_RPC = 'http://127.0.0.1:1';
function run(args, env) {
  return spawnSync(process.execPath, ['scripts/arcousd/run-keeper.mjs', ...args], {
    cwd: root, encoding: 'utf8', timeout: 120000, env: { PATH: process.env.PATH, NODE_OPTIONS: '', ...env } });
}

test('keeper launcher refuses bad arguments, secret environment variables and invalid settings', () => {
  assert.equal(run(['--keystore', 'relative.json', '--password-file', '/p'], {}).stderr, 'ARCOUSD_KEEPER_START_FAILED stage=ARGUMENTS\n');
  assert.equal(run(['--keystore', '/k'], {}).stderr, 'ARCOUSD_KEEPER_START_FAILED stage=ARGUMENTS\n');
  const secret = run([], { ARCOUSD_KEEPER_KEYSTORE_PASSWORD: 'SYNTHETIC_FORBIDDEN_INPUT', INDEXER_RPC_URL: NO_RPC });
  assert.equal(secret.status, 1);
  assert.equal(secret.stderr, 'ARCOUSD_KEEPER_START_FAILED stage=ENVIRONMENT\n');
  assert.doesNotMatch(secret.stdout + secret.stderr, /SYNTHETIC_FORBIDDEN_INPUT/);
  // Any variable shaped like a key or keystore password is refused too.
  for (const name of ['TREASURY_PRIVATE_KEY', 'SOME_MNEMONIC', 'ARCOUSD_KEEPER_PASSWORD']) {
    assert.equal(run([], { [name]: 'SYNTHETIC', INDEXER_RPC_URL: NO_RPC }).stderr, 'ARCOUSD_KEEPER_START_FAILED stage=ENVIRONMENT\n', name);
  }
  const invalid = run(['--check'], { INDEXER_RPC_URL: NO_RPC, ARCOUSD_KEEPER_MODE: 'live', ARCOUSD_KEEPER_BATCH: '99' });
  assert.equal(invalid.stderr, 'ARCOUSD_KEEPER_CONFIG_INVALID ARCOUSD_KEEPER_ADDRESS,ARCOUSD_KEEPER_BATCH\nARCOUSD_KEEPER_START_FAILED stage=CONFIG\n');
  const noKeystore = run(['--check'], { INDEXER_RPC_URL: NO_RPC, ARCOUSD_KEEPER_MODE: 'live', ARCOUSD_KEEPER_ADDRESS: '0x00000000000000000000000000000000000000ee' });
  assert.equal(noKeystore.stderr, 'ARCOUSD_KEEPER_START_FAILED stage=KEYSTORE\n');
});

test('keeper launcher unlocks the live keystore from secret files and never echoes the password', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcousd-keeper-launcher-'));
  try {
    const requireContracts = createRequire(new URL('../../packages/contracts/package.json', import.meta.url));
    const { Wallet } = requireContracts('ethers');
    const wallet = Wallet.createRandom();
    const password = `SYNTHETIC-${randomBytes(12).toString('hex')}`;
    const keystore = join(dir, 'keystore.json');
    const passwordFile = join(dir, 'password');
    // A cheap scrypt (N = 2^14, the loader's minimum) keeps the test fast. Secret mounts are not
    // owner-only; the launcher unlocks from a private copy.
    writeFileSync(keystore, await wallet.encrypt(password, { scrypt: { N: 16384 } }), { mode: 0o644 });
    writeFileSync(passwordFile, `${password}\n`, { mode: 0o644 });
    const base = { INDEXER_RPC_URL: NO_RPC, ARCOUSD_KEEPER_MODE: 'live', ARCOUSD_KEEPER_ADDRESS: wallet.address };
    const args = ['--keystore', keystore, '--password-file', passwordFile, '--check'];

    const unlocked = run(args, base);
    assert.equal(unlocked.stderr.split(' error=')[0], 'ARCOUSD_KEEPER_START_FAILED stage=RPC'); // past the unlock
    assert.doesNotMatch(unlocked.stdout + unlocked.stderr, new RegExp(password));

    writeFileSync(passwordFile, 'WRONG-PASSWORD\n');
    assert.equal(run(args, base).stderr, 'ARCOUSD_KEEPER_START_FAILED stage=KEYSTORE\n');
    writeFileSync(passwordFile, `${password}\n`);
    const other = run(args, { ...base, ARCOUSD_KEEPER_ADDRESS: '0x00000000000000000000000000000000000000ee' });
    assert.equal(other.stderr, 'ARCOUSD_KEEPER_START_FAILED stage=KEYSTORE\n'); // the keystore must be this address

    // dry-run never touches the key files (none given) and gets as far as the RPC.
    const dry = run(['--check'], { INDEXER_RPC_URL: NO_RPC, ARCOUSD_KEEPER_MODE: 'dry-run', ARCOUSD_KEEPER_ADDRESS: wallet.address });
    assert.equal(dry.stderr.split(' error=')[0], 'ARCOUSD_KEEPER_START_FAILED stage=RPC');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

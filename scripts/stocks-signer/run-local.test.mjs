import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { testManifest } from '../../server/dist/stocks/test-fixtures.js';
import { manifestDigest } from '../../server/dist/stocks/contracts.js';

test('operator CLI rejects non-interactive execution before reading any keystore or configuration', () => {
  const result = spawnSync(process.execPath, ['scripts/stocks-signer/run-local.mjs', '--config', '/missing-public-config.json',
    '--keystore', '/missing-encrypted-keystore.json', '--serve'], {
    cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, NODE_OPTIONS: '', GIWA_KEYSTORE_PASSWORD: 'SYNTHETIC_FORBIDDEN_INPUT' },
  });
  assert.ifError(result.error); assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'SIGNER_LOCAL_HOST_START_FAILED: use a local terminal and verify reviewed config, encrypted wallet, dedicated database and token.\n');
  assert.doesNotMatch(result.stderr, /SYNTHETIC_FORBIDDEN_INPUT|missing-public|missing-encrypted|password:/);
});

test('SIGTERM and SIGINT cancel a hidden TTY prompt and restore its terminal without unlocking', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'giwa-signer-tty-'));
  try {
    const requireContracts = createRequire(new URL('../../packages/contracts/package.json', import.meta.url));
    const { Wallet } = requireContracts('ethers');
    const wallet = Wallet.createRandom();
    const manifest = { ...testManifest(), signerAddress: wallet.address.toLowerCase() };
    const config = { schemaVersion: 1, profile: 'DEMO_TESTNET', manifest, reviewedManifestDigest: manifestDigest(manifest),
      reviewedInitialNonce: '0', rpcUrl: 'https://sepolia-rpc.giwa.io', listen: { host: '127.0.0.1', port: 8081 },
      custody: { type: 'LOCAL_KEYSTORE', exclusiveAccountControlConfirmed: true },
      transaction: { gas: '1000000', maxFeePerGas: '1000000', maxPriorityFeePerGas: '1000' },
      limits: { maxGas: '2000000', maxFeePerGas: '1000000', maxTotalFeeWei: '2000000000000' } };
    const configPath = join(directory, 'config.json'), keyPath = join(directory, 'encrypted-wallet.json');
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    writeFileSync(keyPath, await wallet.encrypt(randomBytes(32).toString('hex'), { scrypt: { N: 16384 } }), { mode: 0o600 });
    // The test never types a password. The production CLI must cancel its own
    // prompt, restore the same slave TTY and exit before any PG/RPC access.
    const python = `
import os, pty, select, signal, subprocess, sys, termios, time
for sig in (signal.SIGTERM, signal.SIGINT):
    master, slave = pty.openpty()
    initial = termios.tcgetattr(slave)
    child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    output = b''
    try:
        deadline = time.monotonic() + 12
        while b'GIWA operator keystore password: ' not in output and time.monotonic() < deadline:
            if select.select([master], [], [], .1)[0]: output += os.read(master, 65536)
            if child.poll() is not None: break
        assert b'GIWA operator keystore password: ' in output, 'HIDDEN_PROMPT_NOT_REACHED'
        # The shared helper writes the label immediately before disabling echo.
        # Wait for that synchronous transition before delivering any input/signal.
        deadline = time.monotonic() + 1
        while termios.tcgetattr(slave)[3] & termios.ECHO and time.monotonic() < deadline:
            time.sleep(.01)
        assert not (termios.tcgetattr(slave)[3] & termios.ECHO), 'PASSWORD_ECHO_ENABLED'
        child.send_signal(sig)
        assert child.wait(timeout=5) == 1, 'CANCEL_DID_NOT_EXIT'
        restored = termios.tcgetattr(slave)
        assert restored[3] & (termios.ECHO | termios.ICANON) == initial[3] & (termios.ECHO | termios.ICANON), 'TTY_NOT_RESTORED'
    finally:
        if child.poll() is None: child.kill(); child.wait()
        os.close(master); os.close(slave)
print('SIGNER_LOCAL_TTY_SIGNAL_CLEANUP_PASSED')
`;
    const result = spawnSync('python3', ['-c', python, process.execPath, 'scripts/stocks-signer/run-local.mjs',
      '--config', configPath, '--keystore', keyPath, '--serve'], {
      cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8', timeout: 40000,
      env: { PATH: process.env.PATH, NODE_OPTIONS: '', STOCKS_SIGNER_DATABASE_URL: 'postgresql://unused@127.0.0.1:1/unused',
        STOCKS_SIGNER_TOKEN: randomBytes(32).toString('hex') },
    });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'SIGNER_LOCAL_TTY_SIGNAL_CLEANUP_PASSED');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

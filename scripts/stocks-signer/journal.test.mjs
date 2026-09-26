import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { testManifest } from '../../server/dist/stocks/test-fixtures.js';
import { manifestDigest } from '../../server/dist/stocks/contracts.js';

const root = resolve(import.meta.dirname, '../..');
const run = (args, env = {}) => spawnSync(process.execPath, ['scripts/stocks-signer/journal.mjs', ...args],
  { cwd: root, encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, NODE_OPTIONS: '', ...env } });

test('journal tool validates arguments, requires the signer database and a seed nonce reviewed in the config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'giwa-signer-journal-'));
  try {
    const manifest = testManifest();
    const config = { schemaVersion: 1, profile: 'DEMO_TESTNET', manifest, reviewedManifestDigest: manifestDigest(manifest),
      reviewedInitialNonce: '7', rpcUrl: 'https://sepolia-rpc.giwa.io', listen: { host: '0.0.0.0', port: 4394 },
      custody: { type: 'SECRET_FILE_KEYSTORE', exclusiveAccountControlConfirmed: true },
      transaction: { gas: '1000000', maxFeePerGas: '1000000', maxPriorityFeePerGas: '1000' },
      limits: { maxGas: '2000000', maxFeePerGas: '1000000', maxTotalFeeWei: '2000000000000' } };
    const path = join(dir, 'config.json'); writeFileSync(path, JSON.stringify(config));
    const db = { STOCKS_SIGNER_DATABASE_URL: 'postgresql://unused@127.0.0.1:1/unused' };
    for (const args of [[], ['--config', 'relative.json', '--status'], ['--config', path], ['--config', path, '--seed'], ['--config', path, '--status', 'x']])
      assert.equal(run(args, db).stderr, 'SIGNER_JOURNAL_COMMAND_FAILED stage=ARGUMENTS\n', args.join(' '));
    assert.equal(run(['--config', path, '--status']).stderr, 'SIGNER_JOURNAL_COMMAND_FAILED stage=ENVIRONMENT\n');
    assert.equal(run(['--config', path, '--seed', '8'], db).stderr, 'SIGNER_JOURNAL_COMMAND_FAILED stage=CONFIG\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestDigest } from '../stocks/contracts.js';
import { testManifest } from '../stocks/test-fixtures.js';
import { parseSignerHostConfig } from './host-config.js';
function config() {
  const manifest = testManifest();
  return { schemaVersion: 1, profile: 'DEMO_TESTNET', manifest, reviewedManifestDigest: manifestDigest(manifest),
    reviewedInitialNonce: '0', rpcUrl: 'https://sepolia-rpc.giwa.io', listen: { host: '127.0.0.1', port: 8081 },
    custody: { type: 'AWS_KMS', region: 'ap-northeast-2', keyArn: 'arn:aws:kms:ap-northeast-2:123456789012:key/12345678-1234-1234-1234-123456789012', exclusiveAccountControlConfirmed: true },
    transaction: { gas: '1000000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000' },
    limits: { maxGas: '2000000', maxFeePerGas: '3000000000', maxTotalFeeWei: '6000000000000000' } };
}
test('strict public configuration freezes manifest and parses exact decimal amounts', () => {
  const input = config(), parsed = parseSignerHostConfig(input);
  assert.equal(parsed.transaction.gas, 1000000n); assert.equal(Object.isFrozen(parsed.custody), true);
  input.manifest.checkpointNumber = '2'; assert.equal(parsed.manifest.checkpointNumber, '1');
  for (const patch of [{ privateKey: 'REJECT_INPUT' }, { token: 'REJECT_INPUT' }, { schemaVersion: 2 },
    { reviewedManifestDigest: '0'.repeat(64) }, { reviewedInitialNonce: '9007199254740992' }, { reviewedInitialNonce: 0 },
    { rpcUrl: 'https://other.invalid' }, { listen: { host: '127.0.0.1', port: 0 } },
    { custody: { ...config().custody, exclusiveAccountControlConfirmed: false } },
    { custody: { ...config().custody, endpoint: 'https://other.invalid' } },
    { transaction: { ...config().transaction, gas: 1000000 } },
    { limits: { ...config().limits, maxTotalFeeWei: '1' } },
    { manifest: { ...config().manifest, privateKey: 'REJECT_INPUT' } }])
    assert.throws(() => parseSignerHostConfig({ ...config(), ...patch }), /^Error: SIGNER_HOST_CONFIGURATION_INVALID$/);
});
test('local keystore host configuration has no credential fields and only binds loopback', () => {
  const local = { ...config(), custody: { type: 'LOCAL_KEYSTORE', exclusiveAccountControlConfirmed: true } };
  const parsed = parseSignerHostConfig(local);
  assert.equal(parsed.custody.type, 'LOCAL_KEYSTORE');
  assert.equal(parsed.listen.host, '127.0.0.1');
  for (const patch of [{ listen: { host: '0.0.0.0', port: 8081 } },
    { custody: { ...local.custody, password: 'REJECT_INPUT' } },
    { custody: { ...local.custody, privateKey: 'REJECT_INPUT' } },
    { custody: { ...local.custody, keystorePath: '/must-use-local-cli' } },
    { custody: { ...local.custody, exclusiveAccountControlConfirmed: false } },
    { custody: { ...local.custody, region: 'ap-northeast-2' } }])
    assert.throws(() => parseSignerHostConfig({ ...local, ...patch }), /^Error: SIGNER_HOST_CONFIGURATION_INVALID$/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestDigest, PLATFORM_TUSDC } from '../stocks/contracts.js';
import { a, h, testManifest } from '../stocks/test-fixtures.js';
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
test('v3 host requires exact external cash identity and rejects mixed v2/v3 keys', () => {
  const v2 = testManifest();
  const manifest = { ...v2, schemaVersion: 3 as const, cashToken: PLATFORM_TUSDC, cashSymbol: 'tUSDC' as const,
    nonUpgradeable: false as const, stockContractsNonUpgradeable: true as const,
    codeHashes: { ...v2.codeHashes, [PLATFORM_TUSDC]: h(700) },
    cashIdentity: { kind: 'ERC1967' as const, implementation: a(701), implementationCodeHash: h(701), proxyAdmin: a(702), proxyAdminCodeHash: h(702) } };
  const input = { ...config(), manifest, reviewedManifestDigest: manifestDigest(manifest), custody: { type: 'LOCAL_KEYSTORE', exclusiveAccountControlConfirmed: true } };
  const result = parseSignerHostConfig(input);
  assert.equal(result.manifest.schemaVersion, 3);
  assert.equal(Object.isFrozen(result.manifest.cashIdentity), true);
  for (const patch of [{ cashIdentity: undefined }, { cashIdentity: { ...manifest.cashIdentity, secret: 'REJECT_INPUT' } },
    { nonUpgradeable: true }, { stockContractsNonUpgradeable: undefined }, { cashToken: v2.cashToken },
    { schemaVersion: 2 }, { unexpected: 'REJECT_INPUT' }]) {
    assert.throws(() => parseSignerHostConfig({ ...input, manifest: { ...manifest, ...patch } }), /SIGNER_HOST_CONFIGURATION_INVALID/);
  }
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

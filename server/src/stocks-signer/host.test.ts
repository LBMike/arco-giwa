import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { manifestDigest } from '../stocks/contracts.js';
import { testManifest } from '../stocks/test-fixtures.js';
import type { SignerHostConfig } from './host-config.js';
import { startStocksSignerHost } from './host.js';
const manifest = testManifest();
const config: SignerHostConfig = {
  manifest, reviewedManifestDigest: manifestDigest(manifest), reviewedInitialNonce: '0',
  rpcUrl: 'https://sepolia-rpc.giwa.io', listen: { host: '127.0.0.1', port: 8081 },
  custody: { type: 'AWS_KMS', region: 'ap-northeast-2',
    keyArn: 'arn:aws:kms:ap-northeast-2:123456789012:key/12345678-1234-1234-1234-123456789012', exclusiveAccountControlConfirmed: true },
  transaction: { gas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n },
  limits: { maxGas: 1n, maxFeePerGas: 1n, maxTotalFeeWei: 1n },
};
test('startup cancellation blocks follow-up RPC reads and cleans up without DB or signing access', async () => {
  const abort = new AbortController();
  let rpcCalls = 0, poolCloses = 0, custodyCloses = 0;
  let release!: (value: string) => void;
  let entered!: () => void;
  const first = new Promise<void>(resolve => { entered = resolve; });
  const host = startStocksSignerHost({ config, signal: abort.signal, mode: 'serve', bearerToken: randomBytes(32).toString('hex'),
    rpc: async () => { rpcCalls++; entered(); return new Promise<string>(resolve => { release = resolve; }); },
    pool: { connect: async () => { throw Error('DATABASE_MUST_NOT_BE_ACCESSED'); },
      query: async () => { throw Error('DATABASE_MUST_NOT_BE_ACCESSED'); }, end: async () => { poolCloses++; } },
    custody: { ready: async () => { throw Error('CUSTODY_MUST_NOT_BE_ACCESSED'); },
      signOriginal: async () => { throw Error('MUST_NOT_SIGN'); }, close: () => { custodyCloses++; } },
  });
  const rejection = assert.rejects(host, /^Error: SIGNER_HOST_NOT_READY$/);
  await first; abort.abort(); release('0x164ce'); await rejection;
  assert.equal(rpcCalls, 1); assert.equal(poolCloses, 1); assert.equal(custodyCloses, 1);
});
test('failed database cleanup still destroys custody and emits only a fixed startup error', async () => {
  let destroys = 0;
  await assert.rejects(startStocksSignerHost({ config, mode: 'serve', bearerToken: 'invalid',
    rpc: async () => { throw Error('NO_RPC_EXPECTED'); },
    pool: { connect: async () => { throw Error('NO_DB_EXPECTED'); }, query: async () => { throw Error('NO_DB_EXPECTED'); },
      end: async () => { throw Error('PRIVATE_DATABASE_URL'); } },
    custody: { ready: async () => false, signOriginal: async () => { throw Error('MUST_NOT_SIGN'); }, close: () => { destroys++; } },
  }), /^Error: SIGNER_HOST_NOT_READY$/);
  assert.equal(destroys, 1);
});

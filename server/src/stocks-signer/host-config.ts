import { freezeManifest, immutable, manifestDigest, StocksError, type Manifest } from '../stocks/contracts.js';
import { validateKmsFees, validateKmsIdentity, type KmsFees } from './custody-kms.js';
import type { SignedTransactionLimits } from './original-transport.js';

export type SignerHostConfig = Readonly<{
  manifest: Manifest; reviewedManifestDigest: string; reviewedInitialNonce: string;
  rpcUrl: string; listen: Readonly<{ host: '127.0.0.1' | '0.0.0.0'; port: number }>;
  custody: Readonly<{ type: 'AWS_KMS'; region: string; keyArn: string; exclusiveAccountControlConfirmed: true }>;
  transaction: KmsFees; limits: SignedTransactionLimits;
}>;
const fail = () => new StocksError('SIGNER_HOST_CONFIGURATION_INVALID', 503);
function record(value: unknown, fields: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== fields.split(',').sort().join(',')) throw fail();
  return value as Record<string, unknown>;
}
function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= 2n ** 256n) throw fail();
  return BigInt(value);
}
export function parseSignerHostConfig(value: unknown): SignerHostConfig {
  try {
    const row = record(value, 'schemaVersion,profile,manifest,reviewedManifestDigest,reviewedInitialNonce,rpcUrl,listen,custody,transaction,limits');
    if (row.schemaVersion !== 1 || row.profile !== 'DEMO_TESTNET') throw fail();
    record(row.manifest, 'schemaVersion,redemptionEscrow,deploymentId,profile,chainId,networkInstance,checkpointNumber,checkpointHash,abiDigest,finalityPolicy,cashToken,cashSymbol,cashScale,stockToken,quantityScale,fundingVault,mintController,signerAddress,codeHashes,restrictedTransfers,nonUpgradeable');
    const manifest = freezeManifest(row.manifest as Manifest);
    if (row.reviewedManifestDigest !== manifestDigest(manifest)
      || decimal(row.reviewedInitialNonce) > BigInt(Number.MAX_SAFE_INTEGER)) throw fail();
    // This service intentionally targets the same public GIWA network as the demo.
    if (row.rpcUrl !== 'https://sepolia-rpc.giwa.io') throw fail();
    const listen = record(row.listen, 'host,port');
    if (!['127.0.0.1', '0.0.0.0'].includes(listen.host as string) || !Number.isSafeInteger(listen.port)
      || (listen.port as number) < 1024 || (listen.port as number) > 65535) throw fail();
    const custody = record(row.custody, 'type,region,keyArn,exclusiveAccountControlConfirmed');
    if (custody.type !== 'AWS_KMS' || custody.exclusiveAccountControlConfirmed !== true
      || typeof custody.region !== 'string' || typeof custody.keyArn !== 'string') throw fail();
    validateKmsIdentity({ region: custody.region, keyArn: custody.keyArn, signerAddress: manifest.signerAddress });
    const tx = record(row.transaction, 'gas,maxFeePerGas,maxPriorityFeePerGas');
    const cap = record(row.limits, 'maxGas,maxFeePerGas,maxTotalFeeWei');
    const transaction = { gas: decimal(tx.gas), maxFeePerGas: decimal(tx.maxFeePerGas), maxPriorityFeePerGas: decimal(tx.maxPriorityFeePerGas) };
    const limits = { maxGas: decimal(cap.maxGas), maxFeePerGas: decimal(cap.maxFeePerGas), maxTotalFeeWei: decimal(cap.maxTotalFeeWei) };
    validateKmsFees(transaction, limits);
    return immutable({ manifest, reviewedManifestDigest: row.reviewedManifestDigest as string,
      reviewedInitialNonce: row.reviewedInitialNonce as string, rpcUrl: row.rpcUrl,
      listen: listen as SignerHostConfig['listen'], custody: custody as SignerHostConfig['custody'], transaction, limits });
  } catch { throw fail(); }
}

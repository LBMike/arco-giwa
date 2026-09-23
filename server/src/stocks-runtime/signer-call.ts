import { decodeFunctionData } from 'viem';
import { ABI, callDigest, ensure, immutable, type AuthorizedCall, type Manifest } from '../stocks/contracts.js';
import { authorizedCall, redemptionCall } from '../stocks/chain.js';

const callFields = ['operationId', 'chainId', 'networkInstance', 'deploymentId', 'from', 'to', 'data', 'value'];

/** The only four operations accepted by either side of the signer protocol. */
export function canonicalStocksSignerCall(manifest: Manifest, value: unknown): { call: AuthorizedCall; digest: string } {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'SIGNER_CALL_CAPABILITY_MISMATCH');
  const row = value as Record<string, unknown>;
  ensure(Object.keys(row).sort().join(',') === [...callFields].sort().join(','), 'SIGNER_CALL_CAPABILITY_MISMATCH');
  // Refunds contain the original funding event ID: network:txHash:logIndex.
  ensure(typeof row.operationId === 'string' && /^(mint|refund|redeem|return):[A-Za-z0-9:_-]{1,256}$/.test(row.operationId), 'SIGNER_CALL_CAPABILITY_MISMATCH');
  ensure(row.chainId === 91342 && row.networkInstance === manifest.networkInstance && row.deploymentId === manifest.deploymentId
    && row.from === manifest.signerAddress && row.value === '0' && typeof row.data === 'string'
    && /^0x(?:[0-9a-f]{2})+$/.test(row.data), 'SIGNER_CALL_SCOPE_MISMATCH');
  let expected: AuthorizedCall | undefined;
  try {
    const decoded = decodeFunctionData({ abi: ABI, data: row.data as `0x${string}` });
    const args: readonly unknown[] = decoded.args;
    if (row.operationId.startsWith('mint:') && decoded.functionName === 'mintForOperation'
      && typeof args[2] === 'string' && typeof args[3] === 'bigint')
      expected = authorizedCall(manifest, row.operationId, 'MINT', args[2], args[3].toString());
    if (row.operationId.startsWith('refund:') && decoded.functionName === 'refundForOperation'
      && typeof args[1] === 'string' && typeof args[2] === 'bigint')
      expected = authorizedCall(manifest, row.operationId, 'REFUND', args[1], args[2].toString());
    if (row.operationId.startsWith('redeem:') && decoded.functionName === 'settleRedemption'
      && typeof args[1] === 'string' && typeof args[2] === 'bigint')
      expected = redemptionCall(manifest, row.operationId, 'REDEEM', args[1] as `0x${string}`, args[2].toString());
    if (row.operationId.startsWith('return:') && decoded.functionName === 'returnEscrowForOperation'
      && typeof args[1] === 'string')
      expected = redemptionCall(manifest, row.operationId, 'RETURN', args[1] as `0x${string}`, '0');
  } catch { /* Decode and canonical construction errors have one public code. */ }
  ensure(expected && row.to === expected.to && row.data === expected.data
    && row.from === expected.from && row.operationId === expected.operationId, 'SIGNER_CALL_CAPABILITY_MISMATCH');
  const call = immutable(expected);
  return { call, digest: callDigest(call) };
}

import { verifyCurrentCashIdentity } from '../stocks/cash-identity.js';
import { freezeManifest, type Manifest } from '../stocks/contracts.js';
import type { JsonRpcTransport } from '../stocks/rpc.js';
import type { ExternalTransactionCustody } from './original-transport.js';

/** New signatures/broadcasts require current cash identity. Historical lookup stays available. */
export function guardCashSigning(input: Manifest, rpc: JsonRpcTransport, custody: ExternalTransactionCustody) {
  const manifest = freezeManifest(input);
  const check = () => verifyCurrentCashIdentity(manifest, rpc);
  return {
    check,
    custody: { async signOriginal(request: Parameters<ExternalTransactionCustody['signOriginal']>[0]) {
      await check(); return custody.signOriginal(request);
    } },
    rpc: (async (method, params) => {
      if (method === 'eth_sendRawTransaction') await check();
      return rpc(method, params);
    }) as JsonRpcTransport,
  };
}

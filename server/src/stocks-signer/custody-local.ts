import type { TransactionSerialized } from 'viem';
import { address, StocksError } from '../stocks/contracts.js';
import { validateKmsFees, type KmsFees } from './custody-kms.js';
import { verifySignedOriginal, type OriginalSignRequest, type SignedTransactionLimits } from './original-transport.js';

/** Capability returned by the reviewed keystore loader; no provider or private-key export. */
export type LocalWalletSigner = (transaction: Readonly<{
  type: 2; chainId: 91342; nonce: string; to: string; data: string; value: string;
  gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string;
}>) => Promise<string>;
const fail = () => new StocksError('SIGNER_LOCAL_CUSTODY_UNAVAILABLE', 503);

export function createLocalKeystoreCustody(options: {
  signerAddress: string; fees: KmsFees; limits: SignedTransactionLimits; signTransaction: LocalWalletSigner;
}) {
  const signerAddress = address(options.signerAddress);
  const fees = Object.freeze({ ...options.fees }), limits = Object.freeze({ ...options.limits });
  validateKmsFees(fees, limits);
  if (typeof options.signTransaction !== 'function') throw fail();
  let sign: LocalWalletSigner | undefined = options.signTransaction;
  return {
    async ready(): Promise<boolean> { return sign !== undefined; },
    async signOriginal(input: OriginalSignRequest): Promise<TransactionSerialized> {
      try {
        if (!sign || !input || Object.keys(input).sort().join(',') !== 'chainId,data,nonce,to,value'
          || input.chainId !== 91342 || input.value !== 0n || typeof input.nonce !== 'bigint'
          || input.nonce < 0n || input.nonce > BigInt(Number.MAX_SAFE_INTEGER)
          || typeof input.data !== 'string' || !/^0x(?:[0-9a-f]{2})*$/.test(input.data)
          || input.data.length > 16_000) throw fail();
        const request = Object.freeze({ ...input, to: address(input.to) as `0x${string}` });
        const transaction = Object.freeze({ type: 2 as const, chainId: 91342 as const,
          nonce: `0x${request.nonce.toString(16)}`, to: request.to, data: request.data, value: '0x0',
          gasLimit: `0x${fees.gas.toString(16)}`, maxFeePerGas: `0x${fees.maxFeePerGas.toString(16)}`,
          maxPriorityFeePerGas: `0x${fees.maxPriorityFeePerGas.toString(16)}` });
        const raw = await sign(transaction);
        if (!sign) throw fail();
        const checked = await verifySignedOriginal(request, signerAddress, raw, limits);
        if (!sign) throw fail();
        return checked.raw;
      } catch { throw fail(); }
    },
    close(): void { sign = undefined; },
  };
}

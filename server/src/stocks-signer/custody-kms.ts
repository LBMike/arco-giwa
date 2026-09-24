import { createPublicKey } from 'node:crypto';
import { GetPublicKeyCommand, KMSClient, SignCommand, type GetPublicKeyCommandOutput, type SignCommandOutput } from '@aws-sdk/client-kms';
import { bytesToHex, hexToBytes, keccak256, recoverAddress, serializeTransaction, type Hex, type TransactionSerialized } from 'viem';
import { publicKeyToAddress } from 'viem/accounts';
import { address, StocksError } from '../stocks/contracts.js';
import { verifySignedOriginal, type OriginalSignRequest, type SignedTransactionLimits } from './original-transport.js';

export type KmsIdentity = Readonly<{ region: string; keyArn: string; signerAddress: string }>;
export type KmsFees = Readonly<{ gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
/** Injection boundary for provider tests; production uses the closed SDK factory below. */
export type KmsSigningPort = {
  getPublicKey(signal: AbortSignal): Promise<Pick<GetPublicKeyCommandOutput, 'KeyId' | 'KeySpec' | 'KeyUsage' | 'SigningAlgorithms' | 'PublicKey'>>;
  sign(digest: Uint8Array, signal: AbortSignal): Promise<Pick<SignCommandOutput, 'KeyId' | 'SigningAlgorithm' | 'Signature'>>;
  destroy(): void;
};
const fail = () => new StocksError('SIGNER_KMS_UNAVAILABLE', 503);
const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export function validateKmsIdentity(input: KmsIdentity): void {
  if (!/^[a-z]{2}-[a-z]+-[1-9]$/.test(input.region)
    || !new RegExp(`^arn:aws:kms:${input.region}:[0-9]{12}:key/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`).test(input.keyArn)) throw fail();
  address(input.signerAddress);
}
export function validateKmsFees(fees: KmsFees, limits: SignedTransactionLimits): void {
  if (Object.values({ ...fees, ...limits }).some(v => typeof v !== 'bigint' || v < 0n || v >= 2n ** 256n)
    || fees.gas <= 0n || fees.maxFeePerGas <= 0n || limits.maxGas <= 0n || limits.maxFeePerGas <= 0n
    || limits.maxTotalFeeWei <= 0n || fees.gas > limits.maxGas || fees.maxFeePerGas > limits.maxFeePerGas
    || fees.maxPriorityFeePerGas > fees.maxFeePerGas || fees.gas * fees.maxFeePerGas > limits.maxTotalFeeWei) throw fail();
}

/** No endpoint, retry strategy, algorithm or key overrides can enter via config/request. */
export function awsKmsSigningPort(input: KmsIdentity): KmsSigningPort {
  validateKmsIdentity(input);
  const keyArn = input.keyArn;
  const client = new KMSClient({ region: input.region, maxAttempts: 1,
    endpoint: `https://kms.${input.region}.amazonaws.com`,
    requestHandler: { connectionTimeout: 2_000, requestTimeout: 5_000, throwOnRequestTimeout: true } });
  return {
    getPublicKey: signal => client.send(new GetPublicKeyCommand({ KeyId: keyArn }), { abortSignal: signal }),
    sign: (digest, signal) => client.send(new SignCommand({ KeyId: keyArn, Message: digest,
      MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' }), { abortSignal: signal }),
    destroy: () => client.destroy(),
  };
}

/** secp256k1 DER signatures fit a short-form sequence of two positive integers. */
function signatureScalars(bytes: Uint8Array): { r: Hex; s: Hex } {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > 72
    || bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2) throw fail();
  let cursor = 2;
  const integer = (): bigint => {
    if (bytes[cursor++] !== 0x02) throw fail();
    const length = bytes[cursor++];
    if (!length || length > 33 || cursor + length > bytes.length) throw fail();
    const part = bytes.slice(cursor, cursor + length);
    cursor += length;
    if (part[0] >= 0x80 || (length > 1 && part[0] === 0 && part[1] < 0x80)) throw fail();
    const result = BigInt(bytesToHex(part));
    if (result <= 0n || result >= order) throw fail();
    return result;
  };
  const r = integer(), originalS = integer();
  if (cursor !== bytes.length) throw fail();
  const s = originalS > order / 2n ? order - originalS : originalS;
  const hex = (v: bigint): Hex => `0x${v.toString(16).padStart(64, '0')}`;
  return { r: hex(r), s: hex(s) };
}

async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, deadlineMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(fail()); }, deadlineMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export function createKmsCustody(options: {
  identity: KmsIdentity; fees: KmsFees; limits: SignedTransactionLimits; port: KmsSigningPort; deadlineMs?: number;
}) {
  const identity = Object.freeze({ ...options.identity });
  const fees = Object.freeze({ ...options.fees }), limits = Object.freeze({ ...options.limits });
  validateKmsIdentity(identity); validateKmsFees(fees, limits);
  const deadlineMs = options.deadlineMs ?? 5_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 10_000) throw fail();
  let closed = false;
  async function checkIdentity(): Promise<void> {
    if (closed) throw fail();
    const result = await bounded(signal => options.port.getPublicKey(signal), deadlineMs);
    if (result.KeyId !== identity.keyArn || result.KeySpec !== 'ECC_SECG_P256K1'
      || result.KeyUsage !== 'SIGN_VERIFY' || !result.SigningAlgorithms?.includes('ECDSA_SHA_256')
      || !(result.PublicKey instanceof Uint8Array) || result.PublicKey.length > 256) throw fail();
    const der = Buffer.from(result.PublicKey);
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'secp256k1'
      || !key.export({ format: 'der', type: 'spki' }).equals(der)) throw fail();
    const jwk = key.export({ format: 'jwk' });
    if (!jwk.x || !jwk.y) throw fail();
    const x = Buffer.from(jwk.x, 'base64url'), y = Buffer.from(jwk.y, 'base64url');
    if (x.length !== 32 || y.length !== 32 || address(publicKeyToAddress(bytesToHex(Buffer.concat([Buffer.from([4]), x, y]))))
      !== address(identity.signerAddress) || closed) throw fail();
  }
  return {
    async ready(): Promise<boolean> {
      try { await checkIdentity(); return true; } catch { return false; }
    },
    async signOriginal(request: OriginalSignRequest): Promise<TransactionSerialized> {
      try {
        if (closed || request.chainId !== 91342 || request.value !== 0n || typeof request.nonce !== 'bigint'
          || request.nonce < 0n || request.nonce > BigInt(Number.MAX_SAFE_INTEGER)
          || !/^0x(?:[0-9a-f]{2})*$/.test(request.data) || request.data.length > 16_000) throw fail();
        const tx = { type: 'eip1559' as const, chainId: 91342, nonce: Number(request.nonce),
          to: address(request.to), data: request.data, value: 0n, ...fees };
        await checkIdentity();
        const digest = keccak256(serializeTransaction(tx));
        const result = await bounded(signal => options.port.sign(hexToBytes(digest), signal), deadlineMs);
        if (closed || result.KeyId !== identity.keyArn || result.SigningAlgorithm !== 'ECDSA_SHA_256' || !result.Signature) throw fail();
        const { r, s } = signatureScalars(result.Signature);
        for (const yParity of [0, 1] as const) {
          let recovered: string;
          try { recovered = await recoverAddress({ hash: digest, signature: { r, s, yParity } }); }
          catch { continue; }
          if (address(recovered) !== address(identity.signerAddress)) continue;
          const serialized = serializeTransaction(tx, { r, s, yParity });
          return (await verifySignedOriginal(request, identity.signerAddress, serialized, limits)).raw;
        }
        throw fail();
      } catch { throw fail(); }
    },
    close(): void { if (!closed) { closed = true; options.port.destroy(); } },
  };
}

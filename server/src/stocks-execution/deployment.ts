import { createHash } from 'node:crypto';
import { ensure, publicManifest, hash, immutable, manifestDigest, StocksError, type Manifest } from '../stocks/contracts.js';
import type { ChainBlock } from '../stocks/chain.js';
import { createStocksRpcPort, type JsonRpcTransport } from '../stocks/rpc.js';
import { verifyStocksDeployment } from '../stocks-runtime/deployment.js';
import type { DeploymentEvidencePort, ReviewedDeployment } from './contracts.js';

const LEASE_MS = 15_000;
type Entry = { value: ReviewedDeployment; monoExpires: number };
type Flight = { active: boolean; promise: Promise<Entry> };

/** Config is not evidence: the first get performs full read-only chain verification. */
export function createDeploymentEvidence(input: Manifest, transport: JsonRpcTransport, options: {
  available?: () => boolean; now?: () => number; monotonicNow?: () => number; timeoutMs?: number;
} = {}): DeploymentEvidencePort {
  // Do not echo unrecognized manifest/config properties into a public response.
  const manifest = publicManifest(input), digest = manifestDigest(manifest);
  ensure(digest === manifestDigest(input), 'EXECUTION_MANIFEST_NOT_PUBLIC', 503);
  const now = options.now ?? Date.now, mono = options.monotonicNow ?? (() => performance.now());
  const available = options.available ?? (() => true), timeout = options.timeoutMs ?? 8000;
  ensure(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 8000, 'EXECUTION_INVALID_TIMEOUT', 503);
  let cached: Entry | null = null, pending: Flight | null = null;
  let lastWall = -Infinity, lastMono = -Infinity;
  const clock = () => {
    const wall = now(), tick = mono();
    ensure(Number.isFinite(wall) && Number.isFinite(tick) && wall >= lastWall && tick >= lastMono, 'EXECUTION_CLOCK_INVALID', 503);
    lastWall = wall; lastMono = tick;
    return { wall, tick };
  };
  const live = () => {
    if (!available()) { cached = null; if (pending) pending.active = false; throw new StocksError('EXECUTION_UNAVAILABLE', 503); }
  };
  const valid = (entry: Entry) => { live(); const t = clock(); return t.wall >= entry.value.verifiedAt && t.wall < entry.value.validUntil && t.tick < entry.monoExpires; };
  async function verify(flight: Flight): Promise<Entry> {
    const start = clock();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => { live(); const t = clock(); ensure(flight.active && t.tick - start.tick < timeout && t.wall - start.wall < timeout, 'EXECUTION_VERIFICATION_TIMEOUT', 503); };
    // Guard each physical transport call, including multi-call ChainPort methods.
    const guarded: JsonRpcTransport = async (method, params) => {
      check(); ensure(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt', 'eth_call'].includes(method), 'EXECUTION_READ_ONLY_RPC', 503);
      const result = await transport(method, params); check(); return immutable(result);
    };
    const work = async (): Promise<Entry> => {
      check();
      const rpc = createStocksRpcPort(guarded, manifest);
      let checkedBlock: ChainBlock | null = null;
      await verifyStocksDeployment(manifest, { ...rpc, block: async number => { const block = await rpc.block(number); if (number === 'finalized') checkedBlock = block; return block; } }, guarded);
      check();
      // Bind this evidence ID to actual finalized history, and recheck the checkpoint after code/binding reads.
      const finalized = checkedBlock as ChainBlock | null;
      const latest = await rpc.block('finalized');
      ensure(finalized && latest && BigInt(latest.number) >= BigInt(finalized.number) && BigInt(finalized.number) >= BigInt(manifest.checkpointNumber), 'EXECUTION_FINALITY_UNAVAILABLE', 503);
      const network = await rpc.network();
      ensure(network.chainId === manifest.chainId && network.networkInstance === manifest.networkInstance && network.checkpointHash === manifest.checkpointHash, 'EXECUTION_CHECKPOINT_CHANGED', 503);
      const canonical = await rpc.block(finalized.number);
      ensure(canonical?.number === finalized.number && canonical.hash === finalized.hash, 'EXECUTION_FINALITY_CHANGED', 503);
      hash(finalized.hash); check();
      const evidenceId = createHash('sha256').update(JSON.stringify({ digest, network, finalized, verifiedAt: start.wall })).digest('hex');
      return { value: immutable({ status: 'VERIFIED', evidenceId, manifestDigest: digest, manifest, verifiedAt: start.wall, validUntil: start.wall + LEASE_MS }), monoExpires: start.tick + LEASE_MS };
    };
    try {
      const result = await Promise.race([work(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { flight.active = false; reject(new StocksError('EXECUTION_VERIFICATION_TIMEOUT', 503)); }, timeout);
      })]);
      check(); cached = result; return result;
    } catch (error) {
      cached = null;
      if (error instanceof StocksError && ['EXECUTION_VERIFICATION_TIMEOUT', 'EXECUTION_UNAVAILABLE', 'EXECUTION_CLOCK_INVALID'].includes(error.code)) throw error;
      throw new StocksError('EXECUTION_DEPLOYMENT_UNVERIFIED', 503);
    } finally { clearTimeout(timer); flight.active = false; }
  }
  return { async get() {
    live(); clock();
    // v3 must re-check current proxy identity on each execution request. A
    // finalized lease alone may predate an upgrade visible at the chain head.
    if (manifest.schemaVersion === 2 && cached && valid(cached)) return cached.value;
    cached = null;
    if (!pending) {
      const flight: Flight = { active: true, promise: undefined! };
      pending = flight;
      flight.promise = Promise.resolve().then(() => verify(flight)).finally(() => { if (pending === flight) pending = null; });
    }
    const result = await pending.promise;
    ensure(valid(result), 'EXECUTION_EVIDENCE_EXPIRED', 503);
    return result.value;
  } };
}

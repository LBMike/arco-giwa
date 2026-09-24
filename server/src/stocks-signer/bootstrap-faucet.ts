import { encodeFunctionData, parseAbi, zeroAddress, type Hex } from 'viem';
import { address, canonicalJson, ensure, freezeManifest, hash, manifestDigest, StocksError, type Manifest, type SqlPool } from '../stocks/contracts.js';
import { ReceiptVerifier, type ChainPort } from '../stocks/chain.js';
import type { JsonRpcTransport } from '../stocks/rpc.js';
import { verifyStocksDeployment } from '../stocks-runtime/deployment.js';
import { verifySignedOriginal, type ExternalTransactionCustody, type SignedTransactionLimits } from './original-transport.js';

export type BootstrapRecordName = 'plan' | 'intent' | 'handoff';
/** Records are create-only. Existing or ambiguous writes MUST throw; never overwrite. */
export type BootstrapStore = {
  read(name: BootstrapRecordName): Promise<unknown | null>;
  create(name: BootstrapRecordName, value: unknown): Promise<void>;
};
export type BootstrapOptions = {
  manifest: Manifest; reviewedManifestDigest: string; recipient: string; amount: string;
  pool: SqlPool; chain: ChainPort; rpc: JsonRpcTransport;
  custody: ExternalTransactionCustody; limits: SignedTransactionLimits; store: BootstrapStore;
};
export type BootstrapResult = Readonly<{
  status: 'PENDING' | 'COMPLETE'; originalTransactionHash: Hex; initialNonce?: string;
}>;
type Plan = {
  version: 1; manifestDigest: string; signer: string; recipient: string; amount: string;
  nonce: string; to: string; data: Hex; maxGas: string; maxFeePerGas: string; maxTotalFeeWei: string;
};
type Handoff = { version: 1; manifestDigest: string; originalTransactionHash: Hex;
  initialNonce: string; blockNumber: string; blockHash: Hex };
const fail = (code = 'BOOTSTRAP_UNAVAILABLE') => new StocksError(code, 503);
function decimal(value: unknown): bigint {
  ensure(typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value)
    && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER), 'BOOTSTRAP_INVALID_NONCE');
  return BigInt(value);
}
function quantity(value: unknown): bigint {
  ensure(typeof value === 'string' && /^0x(0|[1-9a-f][0-9a-f]{0,13})$/.test(value), 'BOOTSTRAP_INVALID_NONCE');
  const result = BigInt(value);
  ensure(result <= BigInt(Number.MAX_SAFE_INTEGER), 'BOOTSTRAP_INVALID_NONCE');
  return result;
}
function row(value: unknown): Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'BOOTSTRAP_RECORD_INVALID');
  return value as Record<string, unknown>;
}
function same(actual: unknown, expected: unknown): void {
  ensure(canonicalJson(actual) === canonicalJson(expected), 'BOOTSTRAP_RECORD_CONFLICT');
}

/** First funding only. One invocation performs at most one send; polling never resends. */
export async function runStocksBootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  let db: Awaited<ReturnType<SqlPool['connect']>> | undefined;
  let begun = false;
  try {
    const m = freezeManifest(options.manifest), digest = manifestDigest(m);
    const signer = address(m.signerAddress), recipient = address(options.recipient);
    ensure(digest === options.reviewedManifestDigest && typeof options.amount === 'string' && /^[1-9][0-9]{0,10}$/.test(options.amount)
      && BigInt(options.amount) <= 10_000_000_000n && recipient !== signer
      && ![m.cashToken, m.stockToken, m.fundingVault, m.mintController, m.redemptionEscrow].map(address).includes(recipient),
    'BOOTSTRAP_SCOPE_INVALID');
    const limits = Object.freeze({ ...options.limits });
    ensure(typeof limits.maxGas === 'bigint' && limits.maxGas > 0n && limits.maxGas <= 2_000_000n
      && typeof limits.maxFeePerGas === 'bigint' && limits.maxFeePerGas > 0n && limits.maxFeePerGas <= 3_000_000_000n
      && typeof limits.maxTotalFeeWei === 'bigint' && limits.maxTotalFeeWei > 0n
      && limits.maxTotalFeeWei <= 6_000_000_000_000_000n, 'BOOTSTRAP_FEE_POLICY_INVALID');
    const data = encodeFunctionData({ abi: parseAbi(['function faucet(address recipient,uint256 amount)']),
      functionName: 'faucet', args: [recipient, BigInt(options.amount)] });
    const planFor = (nonce: string): Plan => ({ version: 1, manifestDigest: digest, signer, recipient,
      amount: options.amount, nonce, to: address(m.cashToken), data,
      maxGas: String(limits.maxGas), maxFeePerGas: String(limits.maxFeePerGas), maxTotalFeeWei: String(limits.maxTotalFeeWei) });

    db = await options.pool.connect();
    await db.query('BEGIN ISOLATION LEVEL READ COMMITTED'); begun = true;
    await db.query("SET LOCAL statement_timeout = '5000ms'");
    await db.query("SET LOCAL lock_timeout = '2000ms'");
    // Also blocks a non-cooperating INSERT seed or normal journal writer. An
    // unseeded host fails readiness; it cannot reserve a nonce behind this lock.
    await db.query('LOCK TABLE stocks_signer.account_nonce IN SHARE ROW EXCLUSIVE MODE');
    const account = (await db.query(`SELECT "networkInstance","checkpointNumber","checkpointHash",
      "initialNonce"::text AS "initialNonce","nextNonce"::text AS "nextNonce"
      FROM stocks_signer.account_nonce WHERE "chainId"=91342 AND "signerAddress"=$1`, [signer])).rows[0];
    const savedPlan = await options.store.read('plan');
    const savedIntent = await options.store.read('intent');
    const savedHandoff = await options.store.read('handoff');
    if (account && !savedHandoff) throw fail('BOOTSTRAP_ACCOUNT_ALREADY_INITIALIZED');
    if (!savedPlan && (savedIntent || savedHandoff)) throw fail('BOOTSTRAP_RECORD_INVALID');

    await verifyStocksDeployment(m, options.chain, options.rpc);
    const snapshot = async () => {
      const finalized = await options.chain.block('finalized');
      ensure(finalized && BigInt(finalized.number) >= BigInt(m.checkpointNumber), 'BOOTSTRAP_FINALITY_UNAVAILABLE');
      const tag = `0x${BigInt(finalized.number).toString(16)}`;
      const roleData = encodeFunctionData({ abi: parseAbi(['function faucetOperator() view returns (address)']), functionName: 'faucetOperator' });
      ensure(await options.rpc('eth_call', [{ to: m.cashToken, data: roleData }, tag])
        === `0x${signer.slice(2).padStart(64, '0')}`, 'BOOTSTRAP_FAUCET_ROLE_MISMATCH');
      const finalizedNonce = quantity(await options.rpc('eth_getTransactionCount', [signer, tag]));
      const pendingNonce = quantity(await options.rpc('eth_getTransactionCount', [signer, 'pending']));
      ensure((await options.chain.block(finalized.number))?.hash === finalized.hash, 'BOOTSTRAP_FINALITY_CHANGED');
      ensure(finalizedNonce === pendingNonce, 'BOOTSTRAP_NONCE_BUSY');
      return finalizedNonce;
    };

    let plan: Plan;
    let original: Hex;
    if (savedPlan) {
      const nonce = String(decimal(row(savedPlan).nonce));
      plan = planFor(nonce); same(savedPlan, plan);
      // Claim persisted before signing. An interrupted claim without a hash
      // cannot prove what was signed; it intentionally requires investigation.
      if (!savedIntent) throw fail('BOOTSTRAP_ORIGINAL_OUTCOME_UNKNOWN');
      original = hash(row(savedIntent).originalTransactionHash as string);
      same(savedIntent, { version: 1, manifestDigest: digest, originalTransactionHash: original });
    } else {
      const nonce = await snapshot();
      ensure(nonce < BigInt(Number.MAX_SAFE_INTEGER), 'BOOTSTRAP_INVALID_NONCE');
      plan = planFor(String(nonce));
      await options.store.create('plan', plan);
      const request = { chainId: 91342 as const, nonce, to: address(m.cashToken), data, value: 0n as const };
      const signed = await verifySignedOriginal(request, signer, await options.custody.signOriginal(request), limits);
      original = signed.txHash;
      await options.store.create('intent', { version: 1, manifestDigest: digest, originalTransactionHash: original });
      ensure(await snapshot() === nonce, 'BOOTSTRAP_NONCE_CHANGED');
      // Failed/lost acknowledgement is indistinguishable from acceptance. The
      // committed intent makes every future invocation lookup-only.
      try { ensure(await options.rpc('eth_sendRawTransaction', [signed.raw]) === original, 'BOOTSTRAP_SEND_UNKNOWN'); }
      catch { /* inspect only this original below */ }
    }
    const pending: BootstrapResult = { status: 'PENDING', originalTransactionHash: original };
    const candidate = await options.rpc('eth_getTransactionByHash', [original]);
    if (candidate === null) {
      ensure(!savedHandoff && !account, 'BOOTSTRAP_FINALIZED_ORIGINAL_MISSING');
      await db.query('COMMIT'); begun = false; return pending;
    }
    const tx = row(candidate);
    ensure(hash(tx.hash as string) === original && address(tx.from as string) === signer
      && address(tx.to as string) === plan.to && quantity(tx.chainId) === 91342n
      && quantity(tx.nonce) === BigInt(plan.nonce) && tx.input === data && quantity(tx.value) === 0n,
    'BOOTSTRAP_ORIGINAL_MISMATCH');
    const proof = await new ReceiptVerifier(m, options.chain).fetch(original);
    if (!proof) {
      ensure(!savedHandoff && !account, 'BOOTSTRAP_FINALIZED_ORIGINAL_MISSING');
      await db.query('COMMIT'); begun = false; return pending;
    }
    ensure(address(proof.tx.from) === signer && address(proof.tx.to) === plan.to && proof.tx.input === data,
      'BOOTSTRAP_ORIGINAL_MISMATCH');
    const transfers = proof.events.filter(e => e.address === address(m.cashToken) && e.name === 'Transfer');
    ensure(transfers.length === 1 && String(transfers[0].args.from).toLowerCase() === zeroAddress
      && address(String(transfers[0].args.to)) === recipient && transfers[0].args.value === BigInt(plan.amount),
    'BOOTSTRAP_MINT_MISMATCH');
    const initialNonce = String(BigInt(plan.nonce) + 1n);
    const handoff: Handoff = { version: 1, manifestDigest: digest, originalTransactionHash: original,
      initialNonce, blockNumber: proof.block.number, blockHash: proof.block.hash };
    if (savedHandoff) same(savedHandoff, handoff);
    if (account) {
      ensure(account.networkInstance === m.networkInstance && account.checkpointNumber === m.checkpointNumber
        && account.checkpointHash === m.checkpointHash && account.initialNonce === initialNonce
        && decimal(account.nextNonce) >= BigInt(initialNonce), 'BOOTSTRAP_HANDOFF_ACCOUNT_MISMATCH');
    } else {
      ensure(await snapshot() === BigInt(initialNonce), 'BOOTSTRAP_HANDOFF_NONCE_MISMATCH');
      // Evidence is durable before DB commit. A lost commit response resumes
      // either exact create-only seed or exact existing binding; never reseeds.
      if (!savedHandoff) await options.store.create('handoff', handoff);
      await db.query(`INSERT INTO stocks_signer.account_nonce
        ("chainId","signerAddress","networkInstance","checkpointNumber","checkpointHash","initialNonce","nextNonce")
        VALUES (91342,$1,$2,$3,$4,$5::numeric,$5::numeric)`,
      [signer, m.networkInstance, m.checkpointNumber, m.checkpointHash, initialNonce]);
    }
    await db.query('COMMIT'); begun = false;
    return { status: 'COMPLETE', originalTransactionHash: original, initialNonce };
  } catch (error) {
    if (db && begun) { try { await db.query('ROLLBACK'); } catch { /* fixed error only */ } }
    if (error instanceof StocksError) throw error;
    throw fail();
  } finally { db?.release(); }
}

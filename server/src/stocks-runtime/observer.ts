import { toEventSelector, type Hex } from 'viem';
import { address, ensure, hash, freezeManifest, manifestDigest, type Manifest, type SqlPool } from '../stocks/contracts.js';
import type { ChainPort } from '../stocks/chain.js';
import type { JsonRpcTransport } from '../stocks/rpc.js';
import type { ReconciliationCoverage } from '../stocks/reconciliation.js';

export type ObserverHooks = {
  observeFunding(txHash: Hex): Promise<unknown>;
  observeEscrow(txHash: Hex): Promise<unknown>;
  isTransactionProjected(txHash: Hex): Promise<boolean>;
};
const fundingEvent = toEventSelector('FundingReceived(bytes32,address,address,uint256)');
const escrowEvent = toEventSelector('StockEscrowed(bytes32,bytes32,address,address,uint256)');
const transferEvent = toEventSelector('Transfer(address,address,uint256)');
const settlements = new Set([
  toEventSelector('StockMinted(bytes32,address,address,uint256)'),
  toEventSelector('FundingRefunded(bytes32,address,uint256)'),
  toEventSelector('StockRedeemed(bytes32,bytes32,address,address,uint256,address,uint256)'),
  toEventSelector('StockReturned(bytes32,bytes32,address,address,uint256)'),
]);
function quantity(input: unknown): bigint { ensure(typeof input === 'string' && /^0x(0|[1-9a-f][0-9a-f]*)$/.test(input), 'OBSERVER_INVALID_QUANTITY'); return BigInt(input); }

// One session-level advisory lock protects an observer without holding a database
// transaction open during RPC or domain calls. A batch cursor advances only after
// every economic effect is recorded; replays of a failed batch are idempotent.
export class StocksFinalizedObserver {
  constructor(private readonly pool: SqlPool, private readonly manifest: Manifest & { redemptionEscrow: string }, private readonly digest: string, private readonly rpc: ChainPort, private readonly transport: JsonRpcTransport, private readonly hooks: ObserverHooks) {
    this.manifest = freezeManifest(manifest) as Manifest & { redemptionEscrow: string };
    ensure(manifestDigest(this.manifest) === digest, 'OBSERVER_DEPLOYMENT_MISMATCH');
  }
  async coverage(): Promise<ReconciliationCoverage | null> {
    const row = (await this.pool.query('SELECT * FROM arco_evm."StocksObserverCursor" WHERE "deploymentDigest"=$1', [this.digest])).rows[0];
    return row && row.version > 0 ? { deploymentDigest: this.digest, throughBlock: row.blockNumber, blockHash: row.blockHash, observedAt: new Date(row.updatedAt).toISOString() } : null;
  }
  async runOnce(): Promise<'CURRENT' | 'CATCHING_UP' | 'WAITING_PROJECTION' | 'BUSY'> {
    const connection = await this.pool.connect();
    let locked = false;
    const lockKey = `stocks-observer:${this.digest}`;
    try {
      locked = (await connection.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [lockKey])).rows[0].acquired === true;
      if (!locked) return 'BUSY';
      const network = await this.rpc.network();
      ensure(network.chainId === 91342 && network.networkInstance === this.manifest.networkInstance && network.checkpointHash === this.manifest.checkpointHash, 'OBSERVER_NETWORK_MISMATCH');
      const checkpoint = await this.rpc.block(this.manifest.checkpointNumber);
      ensure(checkpoint?.hash === this.manifest.checkpointHash, 'OBSERVER_CHECKPOINT_MISMATCH');
      await connection.query('INSERT INTO arco_evm."StocksObserverCursor" ("deploymentDigest","blockNumber","blockHash",version,"updatedAt") VALUES ($1,$2,$3,0,clock_timestamp()) ON CONFLICT ("deploymentDigest") DO NOTHING', [this.digest, checkpoint.number, checkpoint.hash]);
      const cursor = (await connection.query('SELECT * FROM arco_evm."StocksObserverCursor" WHERE "deploymentDigest"=$1', [this.digest])).rows[0];
      const [canonical, final] = await Promise.all([this.rpc.block(cursor.blockNumber), this.rpc.block('finalized')]);
      ensure(canonical?.hash === cursor.blockHash && final && BigInt(cursor.blockNumber) <= BigInt(final.number), 'OBSERVER_CURSOR_OR_FINALITY_INVALID');
      const now = BigInt(Math.floor(Date.now() / 1000));
      ensure(BigInt(final.timestamp) <= now + 120n && now - BigInt(final.timestamp) <= 3600n, 'OBSERVER_STALE_FINALIZED_HEAD');
      // Version zero is an unscanned checkpoint, not observation coverage. Scan
      // that block inclusively so a same-block deposit cannot be lost at startup.
      const from = BigInt(cursor.blockNumber) + (cursor.version === 0 ? 0n : 1n);
      const end = BigInt(final.number) < from + 99n ? BigInt(final.number) : from + 99n;
      const endBlock = await this.rpc.block(end.toString());
      ensure(endBlock, 'OBSERVER_CUTOFF_UNAVAILABLE');
      if (from <= end) {
        const contracts = [this.manifest.cashToken, this.manifest.stockToken, this.manifest.fundingVault, this.manifest.mintController, this.manifest.redemptionEscrow].map(address);
        const value = await this.transport('eth_getLogs', [{ address: contracts, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${end.toString(16)}` }]);
        ensure(Array.isArray(value) && value.length <= 10000, 'OBSERVER_LOG_RANGE_INVALID');
        const transactions = new Map<string, { hash: Hex; block: bigint; index: bigint; funding: boolean; escrow: boolean; settlement: boolean }>();
        for (const raw of value) {
          ensure(raw && typeof raw === 'object' && !raw.removed && Array.isArray(raw.topics), 'OBSERVER_LOG_INVALID');
          const block = quantity(raw.blockNumber); const index = quantity(raw.transactionIndex);
          ensure(block >= from && block <= end && contracts.includes(address(raw.address)), 'OBSERVER_LOG_OUTSIDE_RANGE');
          const txHash = hash(raw.transactionHash);
          const item = transactions.get(txHash) ?? { hash: txHash, block, index, funding: false, escrow: false, settlement: false };
          ensure(item.block === block && item.index === index, 'OBSERVER_TRANSACTION_CONFLICT');
          const emitter = address(raw.address); const topic = raw.topics[0];
          item.funding ||= (emitter === address(this.manifest.fundingVault) && topic === fundingEvent) || (emitter === address(this.manifest.cashToken) && topic === transferEvent && raw.topics[2] === `0x${this.manifest.fundingVault.slice(2).toLowerCase().padStart(64, '0')}`);
          item.escrow ||= emitter === address(this.manifest.redemptionEscrow) && topic === escrowEvent;
          item.settlement ||= settlements.has(topic);
          transactions.set(txHash, item);
        }
        const ordered = [...transactions.values()].sort((a, b) => a.block < b.block ? -1 : a.block > b.block ? 1 : a.index < b.index ? -1 : a.index > b.index ? 1 : 0);
        for (const tx of ordered) {
          if (tx.funding) ensure((await this.hooks.observeFunding(tx.hash) as { status?: string } | null)?.status !== 'FINALITY_PENDING', 'OBSERVER_FUNDING_NOT_FINAL');
          if (tx.escrow) ensure((await this.hooks.observeEscrow(tx.hash) as { status?: string } | null)?.status !== 'FINALITY_PENDING', 'OBSERVER_ESCROW_NOT_FINAL');
          if (tx.settlement && !(await this.hooks.isTransactionProjected(tx.hash))) return 'WAITING_PROJECTION';
        }
      }
      // Recheck the exact cutoff after the external calls before declaring coverage.
      ensure((await this.rpc.block(endBlock.number))?.hash === endBlock.hash, 'OBSERVER_CUTOFF_CHANGED');
      const updated = await connection.query('UPDATE arco_evm."StocksObserverCursor" SET "blockNumber"=$1,"blockHash"=$2,version=version+1,"updatedAt"=clock_timestamp() WHERE "deploymentDigest"=$3 AND version=$4', [endBlock.number, endBlock.hash, this.digest, cursor.version]);
      ensure(updated.rowCount === 1, 'OBSERVER_CURSOR_CONFLICT');
      return end === BigInt(final.number) ? 'CURRENT' : 'CATCHING_UP';
    } finally {
      try { if (locked) await connection.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lockKey]); }
      finally { connection.release(); }
    }
  }
}

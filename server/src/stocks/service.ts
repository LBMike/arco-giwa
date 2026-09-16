import { StocksSellService, type EscrowReturnPolicy } from './sell-service.js';
import { randomUUID } from 'node:crypto';
import { address, ensure, immutable, manifestDigest, operationKey, PROFILE, units, validateActor, freezeManifest, type Activation, type Actor, type Manifest, type PausePolicy, type SqlClient } from './contracts.js';
import { authorizedCall, ReceiptVerifier } from './chain.js';
import { StocksRepository } from './repository.js';
import type { Hex } from 'viem';
export type RefundPolicy = (input: {
    fundingId: string;
    reason: string;
    payer: string;
    verifiedWallet: string;
    orderState: string;
}) => Promise<boolean>;
export class StocksService {
    readonly digest: string;
    readonly sell: StocksSellService;
    constructor(readonly repo: StocksRepository, readonly manifest: Manifest, readonly verifier: ReceiptVerifier, private readonly activation?: Activation, readonly paused: PausePolicy = async () => true, private readonly refundPolicy: RefundPolicy = async () => false, returnPolicy?: EscrowReturnPolicy) {
        this.manifest = freezeManifest(manifest);
        this.digest = manifestDigest(this.manifest);
        if (activation)
            this.activation = Object.freeze(structuredClone(activation));
        ensure(repo.deploymentDigest === this.digest, 'REPOSITORY_DEPLOYMENT_MISMATCH');
        ensure(this.digest === manifestDigest(verifier.manifest), 'VERIFIER_DEPLOYMENT_MISMATCH');
        this.sell = new StocksSellService(this, returnPolicy);
    }
    requireActivation(): void { ensure(this.activation?.manifestDigest === this.digest && this.activation.contractPolicyVerified === true, 'STOCKS_NOT_ACTIVATED', 503); }
    async bindDeployment(): Promise<void> {
        this.requireActivation();
        const scope = `cash:${this.manifest.networkInstance}:${address(this.manifest.fundingVault)}:${address(this.manifest.cashToken)}`;
        await this.repo.pool.query('INSERT INTO arco_evm."StocksLiquidityBinding" ("scopeKey","deploymentDigest") VALUES($1,$2) ON CONFLICT DO NOTHING', [scope, this.digest]);
        const binding = (await this.repo.pool.query('SELECT "deploymentDigest" FROM arco_evm."StocksLiquidityBinding" WHERE "scopeKey"=$1', [scope])).rows[0];
        ensure(binding?.deploymentDigest === this.digest, 'VAULT_ALREADY_BOUND_TO_OTHER_DEPLOYMENT', 503);
    }
    async ready(): Promise<void> { await this.bindDeployment(); ensure(this.activation?.manifestDigest === this.digest && this.activation.contractPolicyVerified === true, 'STOCKS_NOT_ACTIVATED', 503); ensure(!(await this.paused()), 'STOCKS_PAUSED', 503); }
    catalog() { return { ...PROFILE, instruments: [{ symbol: 'NVDA', quantityScale: 9, price: '120.000000', priceSource: 'FIXED_MOCK_PRICE', orderCapability: this.activation?.manifestDigest === this.digest ? 'CHECK_PAUSE_AT_ORDER' : 'NOT_ACTIVATED' }], cashSymbol: this.manifest.cashSymbol, deploymentId: this.manifest.deploymentId, observedAt: new Date().toISOString() }; }
    async quote(actor: Actor, symbol: string, quantity: unknown) {
        actor = immutable(actor);
        validateActor(actor);
        await this.ready();
        ensure(symbol === 'NVDA', 'UNSUPPORTED_SYMBOL');
        const value = units(quantity, 9);
        const cash = (value * 120000000n + 999999999n) / 1000000000n;
        const id = randomUUID();
        return this.repo.tx(async (db) => {
            const row = (await db.query('INSERT INTO arco_evm."StocksQuote" (id,"actorId",wallet,symbol,quantity,"cashAmount","deploymentDigest","expiresAt") VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval \'60 seconds\') RETURNING *', [id, actor.actorId, address(actor.wallet), symbol, value.toString(), cash.toString(), this.digest])).rows[0];
            await this.repo.audit(db, id, 'QUOTE_CREATED', { actorId: actor.actorId });
            return row;
        });
    }
    async createOrder(actor: Actor, quoteId: string, idempotencyKey: string) {
        actor = immutable(actor);
        validateActor(actor);
        await this.ready();
        ensure(typeof quoteId === 'string' && quoteId.length <= 128 && typeof idempotencyKey === 'string' && /^[a-zA-Z0-9:_-]{8,128}$/.test(idempotencyKey), 'INVALID_ORDER_REQUEST');
        return this.repo.tx(async (db) => {
            // Serialize the actor/key before checking for an existing row; a unique constraint is the backstop.
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`stocks:${actor.actorId}:${idempotencyKey}`]);
            const existing = (await db.query('SELECT * FROM arco_evm."StocksOrder" WHERE "actorId"=$1 AND "idempotencyKey"=$2', [actor.actorId, idempotencyKey])).rows[0];
            if (existing) {
                ensure(existing.quoteId === quoteId && existing.wallet === address(actor.wallet) && existing.deploymentDigest === this.digest, 'IDEMPOTENCY_CONFLICT', 409);
                return existing;
            }
            const q = (await db.query('SELECT *, "expiresAt">clock_timestamp() AS valid FROM arco_evm."StocksQuote" WHERE id=$1 FOR UPDATE', [quoteId])).rows[0];
            ensure(q && q.actorId === actor.actorId && q.wallet === address(actor.wallet), 'QUOTE_NOT_FOUND', 404);
            ensure(q.deploymentDigest === this.digest && q.valid, 'QUOTE_EXPIRED_OR_DEPLOYMENT_CHANGED', 409);
            const used = (await db.query('SELECT id FROM arco_evm."StocksOrder" WHERE "quoteId"=$1', [quoteId])).rows[0];
            ensure(!used, 'QUOTE_ALREADY_USED', 409);
            const id = randomUUID();
            const row = (await db.query('INSERT INTO arco_evm."StocksOrder" (id,"orderKey","quoteId","actorId",wallet,symbol,quantity,"cashAmount","idempotencyKey","deploymentId","deploymentDigest","quoteExpiresAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *', [id, operationKey(`${this.manifest.networkInstance}:${id}`), q.id, q.actorId, q.wallet, q.symbol, q.quantity, q.cashAmount, idempotencyKey, this.manifest.deploymentId, this.digest, q.expiresAt])).rows[0];
            await this.repo.audit(db, id, 'ORDER_CREATED', { actorId: actor.actorId, deploymentDigest: this.digest });
            return row;
        });
    }
    // Internal indexer boundary only. A hash causes a fresh trusted RPC read; clients cannot submit proof envelopes.
    async observeFunding(txHash: Hex) {
        await this.bindDeployment();
        ensure(this.activation?.manifestDigest === this.digest, 'STOCKS_NOT_ACTIVATED', 503);
        const proof = await this.verifier.fetch(txHash);
        if (!proof)
            return { status: 'FINALITY_PENDING' };
        const evidenceDigest = operationKey(JSON.stringify({ receipt: proof.receipt, tx: proof.tx }));
        if (!proof.events.some(e => e.name === 'FundingReceived')) {
            const incoming = this.verifier.unallocated(proof);
            return this.repo.tx(async (db) => {
                const recorded = [];
                for (const item of incoming.sort((a, b) => a.eventId.localeCompare(b.eventId))) {
                    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [item.eventId]);
                    const existing = (await db.query('SELECT * FROM arco_evm."StocksFunding" WHERE id=$1', [item.eventId])).rows[0];
                    if (existing) {
                        recorded.push(existing.proof.evidenceDigest === evidenceDigest ? existing : await this.fundingConflict(db, existing, evidenceDigest));
                        continue;
                    }
                    const row = (await db.query(`INSERT INTO arco_evm."StocksFunding" (id,payer,amount,status,reason,"txHash",proof,"deploymentDigest") VALUES ($1,$2,$3,'SUSPENSE','UNATTRIBUTED_TRANSFER',$4,$5,$6) RETURNING *`, [item.eventId, item.payer, item.amount, txHash, JSON.stringify({ blockHash: proof.block.hash, blockNumber: proof.block.number, evidenceDigest, deploymentDigest: this.digest }), this.digest])).rows[0];
                    await this.repo.journal(db, `funding:${item.eventId}`, this.manifest.cashToken, 'CASH_VAULT', `SUSPENSE:${item.eventId}`, item.amount, proof.block.number);
                    await this.repo.audit(db, item.eventId, 'UNALLOCATED_FUNDING_RECORDED', { txHash });
                    recorded.push(row);
                }
                return recorded;
            });
        }
        const funding = this.verifier.funding(proof);
        return this.repo.tx(async (db) => {
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [funding.eventId]);
            const duplicate = (await db.query('SELECT * FROM arco_evm."StocksFunding" WHERE id=$1', [funding.eventId])).rows[0];
            if (duplicate)
                return duplicate.proof.evidenceDigest === evidenceDigest ? duplicate : this.fundingConflict(db, duplicate, evidenceDigest);
            const order = (await db.query('SELECT * FROM arco_evm."StocksOrder" WHERE "orderKey"=$1 FOR UPDATE', [funding.orderKey])).rows[0];
            let reason = 'UNIDENTIFIED_ORDER';
            if (order) {
                if (order.deploymentDigest !== this.digest)
                    reason = 'DEPLOYMENT_MISMATCH';
                else if (order.wallet !== funding.payer)
                    reason = 'WRONG_WALLET';
                else if (order.state !== 'AWAITING_FUNDING')
                    reason = 'SECOND_PAYMENT';
                else if (BigInt(funding.blockTimestamp) * 1000n > BigInt(new Date(order.quoteExpiresAt).getTime()))
                    reason = 'QUOTE_EXPIRED';
                else if (order.cashAmount !== funding.amount)
                    reason = 'AMOUNT_MISMATCH';
                else
                    reason = 'EXACT_PAYMENT';
            }
            const accepted = reason === 'EXACT_PAYMENT';
            const row = (await db.query('INSERT INTO arco_evm."StocksFunding" (id,"orderId",payer,amount,status,reason,"txHash",proof,"deploymentDigest") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [funding.eventId, order?.id ?? null, funding.payer, funding.amount, accepted ? 'ACCEPTED' : 'SUSPENSE', reason, txHash, JSON.stringify({ blockHash: proof.block.hash, blockNumber: proof.block.number, evidenceDigest, deploymentDigest: this.digest, orderKey: funding.orderKey }), this.digest])).rows[0];
            await this.repo.journal(db, `funding:${funding.eventId}`, this.manifest.cashToken, 'CASH_VAULT', accepted ? `ORDER_RESERVED:${order.id}` : `SUSPENSE:${funding.eventId}`, funding.amount, proof.block.number);
            await this.repo.audit(db, order?.id ?? funding.eventId, 'FUNDING_RECORDED', { fundingId: funding.eventId, reason });
            if (order && order.state === 'AWAITING_FUNDING' && order.wallet === funding.payer && order.deploymentDigest === this.digest) {
                await this.repo.state(db, order, accepted ? 'BROKER_PENDING' : reason === 'QUOTE_EXPIRED' ? 'FUNDED_QUOTE_EXPIRED' : 'FUNDING_REVIEW_REQUIRED');
                if (accepted)
                    await this.repo.enqueue(db, `broker:${order.id}`, order.id, 'BROKER', { operationId: `broker:${order.id}`, orderId: order.id, symbol: 'NVDA', quantity: order.quantity, cashAmount: order.cashAmount });
            }
            return row;
        });
    }
    private async fundingConflict(db: SqlClient, previous: Record<string, any>, evidenceDigest: string) {
        await this.repo.audit(db, previous.orderId ?? previous.id, 'FUNDING_EVIDENCE_CONFLICT', { fundingId: previous.id, originalEvidenceDigest: previous.proof.evidenceDigest, conflictingEvidenceDigest: evidenceDigest });
        if (previous.orderId && previous.deploymentDigest === this.digest) {
            const order = await this.repo.order(db, previous.orderId);
            if (!['COMPLETED', 'REFUNDED', 'REVIEW_REQUIRED'].includes(order.state))
                await this.repo.state(db, order, 'REVIEW_REQUIRED');
            await db.query(`UPDATE arco_evm."StocksOutbox" SET status='REVIEW',"leaseId"=NULL,"leaseUntil"=NULL WHERE "orderId"=$1 AND "deploymentDigest"=$2 AND status NOT IN ('DONE','REVIEW')`, [order.id, this.digest]);
        }
        return { ...previous, conflict: 'REVIEW_REQUIRED' };
    }
    async requestRefund(fundingId: string): Promise<{
        operationId: string;
    }> {
        await this.ready();
        // Read the immutable funding fact and ask a trusted policy outside the transaction.
        const row = (await this.repo.pool.query('SELECT f.*,o.wallet,o.state AS "orderState" FROM arco_evm."StocksFunding" f JOIN arco_evm."StocksOrder" o ON o.id=f."orderId" WHERE f.id=$1 AND f."deploymentDigest"=$2', [fundingId, this.digest])).rows[0];
        ensure(row && row.payer === row.wallet && row.reason !== 'EXACT_PAYMENT' && row.reason !== 'DEPLOYMENT_MISMATCH', 'REFUND_INELIGIBLE', 409);
        ensure(await this.refundPolicy({ fundingId, reason: row.reason, payer: row.payer, verifiedWallet: row.wallet, orderState: row.orderState }), 'REFUND_POLICY_DENIED', 403);
        return this.repo.tx(async (db) => {
            const current = (await db.query('SELECT * FROM arco_evm."StocksFunding" WHERE id=$1 FOR UPDATE', [fundingId])).rows[0];
            const operationId = `refund:${fundingId}`;
            if (['REFUND_PENDING', 'REFUNDED'].includes(current.status))
                return { operationId };
            ensure(current.status === 'SUSPENSE', 'REFUND_INELIGIBLE', 409);
            const call = authorizedCall(this.manifest, operationId, 'REFUND', current.payer, current.amount);
            await this.repo.enqueue(db, operationId, current.orderId, 'REFUND', { call, wallet: current.payer, amount: current.amount, fundingId });
            await db.query('UPDATE arco_evm."StocksFunding" SET status=\'REFUND_PENDING\' WHERE id=$1', [fundingId]);
            await this.repo.audit(db, current.orderId, 'REFUND_INTENT_CREATED', { fundingId, operationId });
            return { operationId };
        });
    }
}

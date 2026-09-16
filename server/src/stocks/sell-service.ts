import { randomUUID } from 'node:crypto';
import type { Hex } from 'viem';
import { address, callDigest, ensure, hash, immutable, liquidityScope, operationKey, units, validateActor, type Actor, type BrokerPort, type SqlClient, type SignerPort } from './contracts.js';
import { redemptionCall } from './chain.js';
import type { StocksService } from './service.js';
import type { Row } from './repository.js';
export type EscrowReturnPolicy = (fact: {
    custodyId: string;
    reason: string;
    payer: string;
    verifiedWallet: string | null;
}) => Promise<boolean>;
export class StocksSellService {
    constructor(readonly parent: StocksService, private readonly returnPolicy: EscrowReturnPolicy = async () => false) { }
    async quote(actor: Actor, symbol: string, quantity: unknown): Promise<Row> {
        actor = immutable(actor);
        validateActor(actor);
        await this.parent.ready();
        ensure(symbol === 'NVDA', 'UNSUPPORTED_SYMBOL');
        const value = units(quantity, 9);
        const cash = value * 120000000n / 1000000000n;
        ensure(cash > 0n, 'ZERO_SELL_PAYOUT');
        return this.parent.repo.tx(async (db) => {
            const row = (await db.query(`INSERT INTO arco_evm."StocksSellQuote" (id,"actorId",wallet,symbol,quantity,"cashAmount","deploymentDigest","expiresAt") VALUES ($1,$2,$3,'NVDA',$4,$5,$6,clock_timestamp()+interval '60 seconds') RETURNING *`, [randomUUID(), actor.actorId, address(actor.wallet), value.toString(), cash.toString(), this.parent.digest])).rows[0];
            await this.parent.repo.audit(db, row.id, 'SELL_QUOTE_CREATED', { actorId: actor.actorId });
            return { ...row, side: 'SELL' };
        });
    }
    async order(db: SqlClient, id: string): Promise<Row> {
        const order = (await db.query('SELECT * FROM arco_evm."StocksSellOrder" WHERE id=$1 AND "deploymentDigest"=$2 FOR UPDATE', [id, this.parent.digest])).rows[0];
        ensure(order, 'SELL_ORDER_NOT_FOUND', 404);
        return order;
    }
    async state(db: SqlClient, order: Row, state: string) {
        ensure((await db.query('UPDATE arco_evm."StocksSellOrder" SET state=$1,version=version+1,"updatedAt"=clock_timestamp() WHERE id=$2 AND version=$3 AND "deploymentDigest"=$4', [state, order.id, order.version, this.parent.digest])).rowCount === 1, 'STALE_SELL_VERSION', 409);
        await this.parent.repo.audit(db, order.id, state, { side: 'SELL', previous: order.state });
    }
    async createOrder(actor: Actor, quoteId: string, key: string): Promise<Row> {
        actor = immutable(actor);
        validateActor(actor);
        await this.parent.ready();
        ensure(typeof quoteId === 'string' && quoteId.length <= 128 && typeof key === 'string' && /^[a-zA-Z0-9:_-]{8,128}$/.test(key), 'INVALID_ORDER_REQUEST');
        const s = this.parent;
        return s.repo.tx(async (db) => {
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`sell-idem:${actor.actorId}:${key}`]);
            const existing = (await db.query('SELECT * FROM arco_evm."StocksSellOrder" WHERE "actorId"=$1 AND "idempotencyKey"=$2', [actor.actorId, key])).rows[0];
            if (existing) {
                ensure(existing.quoteId === quoteId && existing.wallet === address(actor.wallet) && existing.deploymentDigest === s.digest, 'IDEMPOTENCY_CONFLICT', 409);
                return { ...existing, side: 'SELL' };
            }
            const q = (await db.query('SELECT *,"expiresAt">clock_timestamp() AS valid FROM arco_evm."StocksSellQuote" WHERE id=$1 FOR UPDATE', [quoteId])).rows[0];
            ensure(q && q.actorId === actor.actorId && q.wallet === address(actor.wallet), 'QUOTE_NOT_FOUND', 404);
            ensure(q.valid && q.deploymentDigest === s.digest, 'QUOTE_EXPIRED_OR_DEPLOYMENT_CHANGED', 409);
            ensure(!(await db.query('SELECT id FROM arco_evm."StocksSellOrder" WHERE "quoteId"=$1', [quoteId])).rows[0], 'QUOTE_ALREADY_USED', 409);
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`stock-wallet:${s.digest}:${q.wallet}`]);
            const position = await s.repo.walletPosition(db, q.wallet);
            ensure(BigInt(position.availableQuantity) >= BigInt(q.quantity), 'INSUFFICIENT_AVAILABLE_STOCK', 409);
            const id = randomUUID();
            const row = (await db.query(`INSERT INTO arco_evm."StocksSellOrder" (id,"orderKey","quoteId","actorId",wallet,symbol,quantity,"cashAmount","idempotencyKey","deploymentId","deploymentDigest","quoteExpiresAt") VALUES($1,$2,$3,$4,$5,'NVDA',$6,$7,$8,$9,$10,$11) RETURNING *`, [id, operationKey(`sell:${s.manifest.networkInstance}:${id}`), q.id, actor.actorId, q.wallet, q.quantity, q.cashAmount, key, s.manifest.deploymentId, s.digest, q.expiresAt])).rows[0];
            await db.query(`INSERT INTO arco_evm."StocksQuantityReservation" ("orderId","deploymentDigest",wallet,quantity,status) VALUES($1,$2,$3,$4,'ACTIVE')`, [id, s.digest, q.wallet, q.quantity]);
            await s.repo.audit(db, id, 'SELL_RESERVED', { quantity: q.quantity, wallet: q.wallet });
            return { ...row, side: 'SELL' };
        });
    }
    async expireReservations(): Promise<number> {
        const s = this.parent;
        const cursor = (await s.repo.pool.query('SELECT * FROM arco_evm."StocksObserverCursor" WHERE "deploymentDigest"=$1', [s.digest])).rows[0];
        if (!cursor || cursor.version === 0)
            return 0;
        const cutoff = await s.verifier.snapshot(cursor.blockNumber, cursor.blockHash, []);
        if (!cutoff)
            return 0;
        return s.repo.tx(async (db) => {
            const orders = (await db.query(`SELECT * FROM arco_evm."StocksSellOrder" WHERE "deploymentDigest"=$1 AND state='AWAITING_ESCROW' AND "quoteExpiresAt"<clock_timestamp() AND "quoteExpiresAt"<to_timestamp($2::double precision) ORDER BY id FOR UPDATE SKIP LOCKED`, [s.digest, cutoff.blockTimestamp])).rows;
            for (const order of orders) {
                await db.query(`UPDATE arco_evm."StocksQuantityReservation" SET status='RELEASED' WHERE "orderId"=$1 AND status='ACTIVE'`, [order.id]);
                await this.state(db, order, 'EXPIRED');
            }
            return orders.length;
        });
    }
    async observeEscrow(txHash: Hex) {
        const s = this.parent;
        await s.bindDeployment();
        const proof = await s.verifier.fetch(txHash);
        if (!proof)
            return { status: 'FINALITY_PENDING' };
        const fact = s.verifier.escrow(proof);
        const digest = operationKey(JSON.stringify({ receipt: proof.receipt, tx: proof.tx }));
        const row = await s.repo.tx(async (db) => {
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [fact.eventId]);
            const prior = (await db.query('SELECT * FROM arco_evm."StocksCustody" WHERE id=$1 OR ("deploymentDigest"=$2 AND "escrowId"=$3) FOR UPDATE', [fact.eventId, s.digest, fact.escrowId])).rows[0];
            if (prior) {
                ensure(prior.proof.evidenceDigest === digest, 'ESCROW_EVIDENCE_CONFLICT', 409);
                return prior;
            }
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`stock-wallet:${s.digest}:${fact.payer}`]);
            const order = (await db.query('SELECT * FROM arco_evm."StocksSellOrder" WHERE "orderKey"=$1 FOR UPDATE', [fact.orderKey])).rows[0];
            let reason = 'UNIDENTIFIED_ORDER';
            if (order) {
                if (order.deploymentDigest !== s.digest)
                    reason = 'DEPLOYMENT_MISMATCH';
                else if (order.wallet !== fact.payer)
                    reason = 'WRONG_WALLET';
                else if (!['AWAITING_ESCROW', 'EXPIRED'].includes(order.state))
                    reason = 'SECOND_ESCROW';
                else if (order.state === 'EXPIRED' || BigInt(fact.blockTimestamp) * 1000n > BigInt(new Date(order.quoteExpiresAt).getTime()))
                    reason = 'QUOTE_EXPIRED';
                else if (order.quantity !== fact.quantity)
                    reason = 'QUANTITY_MISMATCH';
                else
                    reason = 'EXACT_ESCROW';
            }
            const custody = (await db.query(`INSERT INTO arco_evm."StocksCustody" (id,"escrowId","orderId","deploymentDigest",payer,quantity,reason,status,"txHash",proof) VALUES($1,$2,$3,$4,$5,$6,$7,'HELD',$8,$9) RETURNING *`, [fact.eventId, fact.escrowId, order?.deploymentDigest === s.digest && order.wallet === fact.payer ? order.id : null, s.digest, fact.payer, fact.quantity, reason, txHash, JSON.stringify({ evidenceDigest: digest, blockNumber: proof.block.number, blockHash: proof.block.hash })])).rows[0];
            await this.movement(db, `escrow:${fact.eventId}`, custody, `-${fact.quantity}`, fact.quantity, '0', proof.block.number, proof.block.hash, txHash);
            await s.repo.journal(db, `escrow:${fact.eventId}`, s.manifest.stockToken, `WALLET:${fact.payer}`, `ESCROW:${fact.escrowId}`, fact.quantity, proof.block.number);
            await s.repo.audit(db, custody.orderId ?? custody.id, 'ESCROW_RECORDED', { custodyId: custody.id, reason });
            if (order && order.deploymentDigest === s.digest && order.wallet === fact.payer && ['AWAITING_ESCROW', 'EXPIRED'].includes(order.state)) {
                await db.query(`UPDATE arco_evm."StocksQuantityReservation" SET status='CONSUMED' WHERE "orderId"=$1 AND status='ACTIVE'`, [order.id]);
                await this.state(db, order, reason === 'EXACT_ESCROW' ? 'ESCROW_HELD' : 'ESCROW_REVIEW_REQUIRED');
            }
            return custody;
        });
        if (row.reason === 'EXACT_ESCROW' && row.orderId && !(await s.paused()))
            await this.reserveLiquidity(row.orderId);
        return row;
    }
    private async movement(db: SqlClient, id: string, custody: Row, wallet: string, escrow: string, supply: string, blockNumber: string, blockHash: string, txHash: string) {
        await db.query('INSERT INTO arco_evm."StocksQuantityMovement" (id,"deploymentDigest",wallet,"custodyId","walletDelta","escrowDelta","supplyDelta","blockNumber","blockHash","txHash") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [id, this.parent.digest, custody.payer, custody.id, wallet, escrow, supply, blockNumber, blockHash, txHash]);
    }
    async reserveLiquidity(orderId: string): Promise<boolean> {
        const s = this.parent;
        await s.ready();
        const snapshot = await s.verifier.latestSnapshot();
        const scope = liquidityScope(s.manifest);
        return s.repo.tx(async (db) => {
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [scope]);
            const order = await this.order(db, orderId);
            if (!['ESCROW_HELD', 'LIQUIDITY_PENDING'].includes(order.state))
                return false;
            const custody = (await db.query(`SELECT * FROM arco_evm."StocksCustody" WHERE "orderId"=$1 AND reason='EXACT_ESCROW' AND status='HELD' FOR UPDATE`, [order.id])).rows[0];
            ensure(custody, 'MISSING_CONFIRMED_ESCROW');
            const liquidity = await s.repo.liquidity(db, s.manifest.cashToken);
            const chain = BigInt(snapshot.cashBalance);
            const recorded = BigInt(liquidity.cashBalance);
            const available = (chain < recorded ? chain : recorded) - BigInt(liquidity.liabilities) - BigInt(liquidity.sellReserved);
            if (available < BigInt(order.cashAmount)) {
                if (order.state !== 'LIQUIDITY_PENDING')
                    await this.state(db, order, 'LIQUIDITY_PENDING');
                return false;
            }
            await db.query(`INSERT INTO arco_evm."StocksCashReservation" ("orderId","deploymentDigest","scopeKey",amount,status,proof) VALUES($1,$2,$3,$4,'RESERVED',$5)`, [order.id, s.digest, scope, order.cashAmount, JSON.stringify(snapshot)]);
            await this.enqueue(db, `sell-broker:${order.id}`, order.id, 'SELL_BROKER', { operationId: `sell-broker:${order.id}`, orderId: order.id, symbol: 'NVDA', side: 'SELL', quantity: order.quantity, cashAmount: order.cashAmount, custodyId: custody.id });
            await this.state(db, order, 'SELL_BROKER_PENDING');
            return true;
        });
    }
    async advanceLiquidity(): Promise<void> {
        const rows = (await this.parent.repo.pool.query(`SELECT id FROM arco_evm."StocksSellOrder" WHERE "deploymentDigest"=$1 AND state IN('ESCROW_HELD','LIQUIDITY_PENDING') ORDER BY "updatedAt",id`, [this.parent.digest])).rows;
        for (const row of rows)
            if (await this.reserveLiquidity(row.id))
                break;
    }
    private async enqueue(db: SqlClient, id: string, sellOrderId: string | null, kind: string, payload: Row) {
        await db.query('INSERT INTO arco_evm."StocksOutbox" (id,"sellOrderId",kind,payload,"deploymentDigest") VALUES($1,$2,$3,$4,$5)', [id, sellOrderId, kind, JSON.stringify(payload), this.parent.digest]);
    }
    async requestReturn(custodyId: string) {
        const s = this.parent;
        await s.ready();
        const fact = (await s.repo.pool.query(`SELECT c.*,o.wallet FROM arco_evm."StocksCustody" c LEFT JOIN arco_evm."StocksSellOrder" o ON o.id=c."orderId" WHERE c.id=$1 AND c."deploymentDigest"=$2`, [custodyId, s.digest])).rows[0];
        ensure(fact && fact.reason !== 'EXACT_ESCROW' && fact.reason !== 'DEPLOYMENT_MISMATCH', 'ESCROW_RETURN_INELIGIBLE', 409);
        ensure(await this.returnPolicy({ custodyId, reason: fact.reason, payer: fact.payer, verifiedWallet: fact.wallet ?? null }), 'ESCROW_RETURN_POLICY_DENIED', 403);
        return s.repo.tx(async (db) => { const custody = (await db.query('SELECT * FROM arco_evm."StocksCustody" WHERE id=$1 FOR UPDATE', [custodyId])).rows[0]; return this.queueReturn(db, custody); });
    }
    private async queueReturn(db: SqlClient, custody: Row) {
        const id = `return:${custody.id}`;
        if (custody.status === 'RETURN_PENDING' || custody.status === 'RETURNED')
            return { operationId: id };
        ensure(custody.status === 'HELD', 'ESCROW_NOT_RETURNABLE', 409);
        const call = redemptionCall(this.parent.manifest, id, 'RETURN', custody.escrowId, '0');
        await this.enqueue(db, id, custody.orderId, 'RETURN', { call, custodyId: custody.id, escrowId: custody.escrowId, wallet: custody.payer, quantity: custody.quantity, cashAmount: '0' });
        await db.query(`UPDATE arco_evm."StocksCustody" SET status='RETURN_PENDING' WHERE id=$1`, [custody.id]);
        if (custody.orderId) {
            const order = await this.order(db, custody.orderId);
            if (!['COMPLETED', 'RETURNED'].includes(order.state))
                await this.state(db, order, 'RETURN_QUEUED');
        }
        await this.parent.repo.audit(db, custody.orderId ?? custody.id, 'RETURN_QUEUED', { custodyId: custody.id });
        return { operationId: id };
    }
    async runJob(job: Row, broker: BrokerPort, signer: SignerPort) {
        const s = this.parent;
        if (job.kind === 'SELL_BROKER') {
            const request = immutable(job.payload);
            const result = job.originalStatus === 'PENDING' ? await broker.submit(request) : await broker.lookup(job.id);
            if (!result || result.outcome === 'UNKNOWN')
                throw new Error('SELL_BROKER_UNKNOWN');
            ensure(result.operationId === job.id && result.mode === 'MOCK_BROKER', 'SELL_BROKER_IDENTITY_MISMATCH');
            ensure(typeof result.quantity === 'string' && /^(0|[1-9]\d{0,35})$/.test(result.quantity) && typeof result.cashAmount === 'string' && /^(0|[1-9]\d{0,35})$/.test(result.cashAmount), 'MALFORMED_SELL_BROKER_AMOUNT');
            await s.repo.tx(async (db) => {
                if (!(await s.repo.leased(db, job)))
                    return;
                const order = await this.order(db, job.sellOrderId);
                ensure(['SELL_BROKER_PENDING', 'SELL_BROKER_UNKNOWN'].includes(order.state), 'SELL_BROKER_STATE_MISMATCH');
                const custody = (await db.query('SELECT * FROM arco_evm."StocksCustody" WHERE id=$1 FOR UPDATE', [request.custodyId])).rows[0];
                ensure(custody?.status === 'HELD' && custody.orderId === order.id, 'SELL_CUSTODY_MISMATCH');
                await s.repo.audit(db, order.id, 'SELL_BROKER_RESULT', { outcome: result.outcome, quantity: result.quantity, cashAmount: result.cashAmount, operationId: job.id });
                if (result.outcome === 'REJECTED') {
                    ensure(result.quantity === '0' && result.cashAmount === '0', 'REJECTION_WITH_EXECUTION');
                    await this.queueReturn(db, custody);
                    await s.repo.finish(db, job, 'DONE');
                    return;
                }
                if (result.outcome === 'PARTIAL') {
                    ensure(BigInt(result.quantity) > 0n && BigInt(result.quantity) < BigInt(order.quantity) && BigInt(result.cashAmount) <= BigInt(order.cashAmount), 'INVALID_PARTIAL_FILL');
                    await this.state(db, order, 'SELL_PARTIAL_HELD');
                    await s.repo.finish(db, job, 'REVIEW');
                    return;
                }
                ensure(result.outcome === 'FILLED' && result.quantity === order.quantity && result.cashAmount === order.cashAmount && request.quantity === order.quantity && request.cashAmount === order.cashAmount, 'SELL_FILL_MISMATCH');
                const id = `redeem:${order.id}`;
                const call = redemptionCall(s.manifest, id, 'REDEEM', custody.escrowId, order.cashAmount);
                await this.enqueue(db, id, order.id, 'REDEEM', { call, custodyId: custody.id, escrowId: custody.escrowId, wallet: order.wallet, quantity: order.quantity, cashAmount: order.cashAmount });
                await db.query(`UPDATE arco_evm."StocksCustody" SET status='REDEEM_PENDING' WHERE id=$1`, [custody.id]);
                await this.state(db, order, 'REDEEM_QUEUED');
                await s.repo.finish(db, job, 'DONE');
            });
            return;
        }
        const call = immutable(job.payload.call);
        const canonical = redemptionCall(s.manifest, job.id, job.kind, job.payload.escrowId, job.payload.cashAmount);
        ensure(job.deploymentDigest === s.digest && callDigest(call) === callDigest(canonical), 'SELL_CALL_IDENTITY_MISMATCH');
        const expectedDigest = callDigest(canonical);
        const submission = job.txHash ? { operationId: job.id, txHash: job.txHash, callDigest: expectedDigest } : job.originalStatus === 'PENDING' ? await signer.submit(call) : await signer.lookup(job.id);
        if (!submission)
            throw new Error('SETTLEMENT_UNKNOWN');
        ensure(submission.operationId === job.id && submission.callDigest === expectedDigest, 'SELL_SIGNER_IDENTITY_MISMATCH');
        hash(submission.txHash);
        const owned = await s.repo.tx(async (db) => {
            if (!(await s.repo.leased(db, job)))
                return false;
            await db.query(`UPDATE arco_evm."StocksOutbox" SET "txHash"=$1,status='SUBMITTED' WHERE id=$2 AND "leaseId"=$3`, [submission.txHash, job.id, job.leaseId]);
            await s.repo.audit(db, job.sellOrderId ?? job.payload.custodyId, 'SELL_CHAIN_SUBMITTED', { operationId: job.id, txHash: submission.txHash });
            return true;
        });
        if (!owned)
            return;
        const proof = await s.verifier.fetch(submission.txHash);
        if (proof)
            s.verifier.redemption(proof, call, job.kind, job.payload.escrowId, job.payload.wallet, job.payload.quantity, job.payload.cashAmount);
        await s.repo.tx(async (db) => {
            if (!(await s.repo.leased(db, job)))
                return;
            if (!proof) {
                if (job.sellOrderId) {
                    const order = await this.order(db, job.sellOrderId);
                    if (!['COMPLETED', 'RETURNED'].includes(order.state))
                        await this.state(db, order, 'SETTLEMENT_PENDING');
                }
                await s.repo.finish(db, job, 'SUBMITTED');
                return;
            }
            const custody = (await db.query('SELECT * FROM arco_evm."StocksCustody" WHERE id=$1 FOR UPDATE', [job.payload.custodyId])).rows[0];
            ensure(custody && custody.escrowId === job.payload.escrowId && custody.payer === job.payload.wallet && custody.quantity === job.payload.quantity, 'PERSISTED_CUSTODY_MISMATCH');
            if (job.kind === 'REDEEM') {
                ensure(custody.status === 'REDEEM_PENDING', 'CUSTODY_REDEEM_STATE_MISMATCH');
                const reservation = (await db.query(`SELECT * FROM arco_evm."StocksCashReservation" WHERE "orderId"=$1 FOR UPDATE`, [job.sellOrderId])).rows[0];
                ensure(reservation?.status === 'RESERVED' && reservation.amount === job.payload.cashAmount, 'SELL_CASH_RESERVATION_MISMATCH');
                await this.movement(db, job.id, custody, '0', `-${custody.quantity}`, `-${custody.quantity}`, proof.block.number, proof.block.hash, submission.txHash);
                await s.repo.journal(db, job.id, s.manifest.cashToken, `SELL_PAYOUT:${job.sellOrderId}`, 'CASH_VAULT', job.payload.cashAmount, proof.block.number);
                await s.repo.journal(db, `${job.id}:burn`, s.manifest.stockToken, `ESCROW:${custody.escrowId}`, 'CONFIRMED_BURNED_SUPPLY', custody.quantity, proof.block.number);
                await db.query(`UPDATE arco_evm."StocksCashReservation" SET status='CONSUMED' WHERE "orderId"=$1`, [job.sellOrderId]);
                await db.query(`UPDATE arco_evm."StocksCustody" SET status='REDEEMED' WHERE id=$1`, [custody.id]);
                await this.state(db, await this.order(db, job.sellOrderId), 'COMPLETED');
            }
            else {
                ensure(custody.status === 'RETURN_PENDING', 'CUSTODY_RETURN_STATE_MISMATCH');
                await this.movement(db, job.id, custody, custody.quantity, `-${custody.quantity}`, '0', proof.block.number, proof.block.hash, submission.txHash);
                await s.repo.journal(db, job.id, s.manifest.stockToken, `ESCROW:${custody.escrowId}`, `WALLET:${custody.payer}`, custody.quantity, proof.block.number);
                await db.query(`UPDATE arco_evm."StocksCustody" SET status='RETURNED' WHERE id=$1`, [custody.id]);
                if (job.sellOrderId) {
                    await db.query(`UPDATE arco_evm."StocksCashReservation" SET status='RELEASED' WHERE "orderId"=$1 AND status='RESERVED'`, [job.sellOrderId]);
                    const order = await this.order(db, job.sellOrderId);
                    if (order.wallet === custody.payer && !['COMPLETED', 'RETURNED'].includes(order.state))
                        await this.state(db, order, 'RETURNED');
                }
            }
            await s.repo.audit(db, job.sellOrderId ?? custody.id, `${job.kind}_FINALIZED`, { operationId: job.id, txHash: submission.txHash, blockHash: proof.block.hash });
            await s.repo.finish(db, job, 'DONE');
        });
    }
}

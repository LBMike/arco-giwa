import { callDigest, ensure, hash, immutable, StocksError, type BrokerPort, type BrokerResult, type SignerPort, type Submission } from './contracts.js';
import { authorizedCall } from './chain.js';
import { type Row } from './repository.js';
import { StocksService } from './service.js';
export class StocksWorker {
    constructor(private readonly service: StocksService, private readonly broker: BrokerPort, private readonly signer: SignerPort) { }
    async runOne(): Promise<boolean> {
        const s = this.service;
        // Activation is checked even for recovery. Pause only blocks NEW irreversible dispatch.
        try {
            await s.ready();
        }
        catch (e) {
            if (!(e instanceof StocksError) || e.code !== 'STOCKS_PAUSED')
                return false;
        }
        const job = await s.repo.claim(await s.paused());
        if (!job)
            return false;
        try {
            if (job.originalStatus === 'PENDING' && await s.paused()) {
                await s.repo.tx(async (db) => { if (await s.repo.leased(db, job))
                    await s.repo.finish(db, job, 'PENDING'); });
                return true;
            }
            if (job.kind !== 'REFUND') {
                await s.repo.tx(async (db) => {
                    const order = await s.repo.order(db, job.orderId);
                    const allowed = job.kind === 'BROKER' ? ['BROKER_PENDING', 'BROKER_UNKNOWN'] : ['MINT_QUEUED', 'MINT_SUBMITTED', 'MINT_FINALITY_PENDING', 'MINT_UNKNOWN'];
                    ensure(allowed.includes(order.state), 'DISPATCH_ORDER_STATE_MISMATCH');
                });
            }
            if (job.kind === 'BROKER')
                await this.brokerJob(job);
            else
                await this.chainJob(job);
        }
        catch (error) {
            // Transport failures cannot prove absence of an external side effect. Never return the intent to PENDING.
            const review = error instanceof StocksError;
            await s.repo.tx(async (db) => {
                if (!(await s.repo.leased(db, job)))
                    return;
                await s.repo.finish(db, job, review ? 'REVIEW' : 'UNKNOWN');
                if (job.orderId && job.kind !== 'REFUND') {
                    const order = await s.repo.order(db, job.orderId);
                    await s.repo.state(db, order, review ? 'REVIEW_REQUIRED' : job.kind === 'BROKER' ? 'BROKER_UNKNOWN' : 'MINT_UNKNOWN');
                }
                await s.repo.audit(db, job.orderId ?? job.id, review ? 'PROVIDER_EVIDENCE_REJECTED' : 'PROVIDER_OUTCOME_UNKNOWN', { operationId: job.id, code: review ? error.code : 'TRANSPORT_OR_DECODING_FAILURE' });
            });
        }
        return true;
    }
    private async brokerJob(job: Row): Promise<void> {
        const s = this.service;
        const request = immutable(job.payload);
        const result: BrokerResult | null = job.originalStatus === 'PENDING' ? await this.broker.submit(request) : await this.broker.lookup(job.id);
        if (!result || result.outcome === 'UNKNOWN')
            throw new Error('BROKER_UNKNOWN');
        ensure(result.operationId === job.id && result.mode === 'MOCK_BROKER', 'BROKER_IDENTITY_MISMATCH');
        ensure(result.outcome === 'FILLED' && result.quantity === request.quantity && result.cashAmount === request.cashAmount, 'UNSUPPORTED_BROKER_RESULT');
        await s.repo.tx(async (db) => {
            if (!(await s.repo.leased(db, job)))
                return;
            const order = await s.repo.order(db, job.orderId);
            ensure(result.quantity === order.quantity && result.cashAmount === order.cashAmount && order.deploymentDigest === job.deploymentDigest, 'PERSISTED_BROKER_REQUEST_MISMATCH');
            ensure(['BROKER_PENDING', 'BROKER_UNKNOWN'].includes(order.state), 'BROKER_ORDER_STATE_MISMATCH');
            await s.repo.journal(db, `broker:${order.id}`, s.manifest.cashToken, `ORDER_RESERVED:${order.id}`, `MOCK_BROKER_EXECUTED:${order.id}`, order.cashAmount);
            const operationId = `mint:${order.id}`;
            const call = authorizedCall(s.manifest, operationId, 'MINT', order.wallet, order.quantity);
            await s.repo.enqueue(db, operationId, order.id, 'MINT', { call, wallet: order.wallet, quantity: order.quantity });
            await s.repo.state(db, order, 'MINT_QUEUED');
            await s.repo.finish(db, job, 'DONE');
        });
    }
    private async chainJob(job: Row): Promise<void> {
        const s = this.service;
        const call = immutable(job.payload.call);
        ensure(job.deploymentDigest === s.digest && call.deploymentId === s.manifest.deploymentId && call.networkInstance === s.manifest.networkInstance && call.chainId === s.manifest.chainId, 'OUTBOX_DEPLOYMENT_MISMATCH');
        const expectedDigest = callDigest(call);
        const canonicalCall = authorizedCall(s.manifest, job.id, job.kind, job.payload.wallet, job.kind === 'MINT' ? job.payload.quantity : job.payload.amount);
        ensure(expectedDigest === callDigest(canonicalCall), 'AUTHORIZED_CALL_PAYLOAD_MISMATCH');
        const submission: Submission | null = job.txHash ? { operationId: job.id, txHash: job.txHash, callDigest: expectedDigest } : job.originalStatus === 'PENDING' ? await this.signer.submit(call) : await this.signer.lookup(job.id);
        if (!submission)
            throw new Error('SUBMISSION_UNKNOWN');
        ensure(submission.operationId === job.id && submission.callDigest === expectedDigest, 'SIGNER_SUBMISSION_MISMATCH');
        hash(submission.txHash);
        // Persist the original hash BEFORE attempting receipt confirmation, even if receipt retrieval fails.
        const owned = await s.repo.tx(async (db) => {
            if (!(await s.repo.leased(db, job)))
                return false;
            await db.query('UPDATE arco_evm."StocksOutbox" SET "txHash"=$1,status=\'SUBMITTED\' WHERE id=$2 AND "leaseId"=$3', [submission.txHash, job.id, job.leaseId]);
            if (job.kind === 'MINT') {
                const order = await s.repo.order(db, job.orderId);
                await s.repo.state(db, order, 'MINT_SUBMITTED');
            }
            await s.repo.audit(db, job.orderId, 'CHAIN_SUBMITTED', { operationId: job.id, txHash: submission.txHash });
            return true;
        });
        if (!owned)
            return;
        const proof = await s.verifier.fetch(submission.txHash);
        if (proof)
            s.verifier.confirmation(proof, call, job.kind, job.kind === 'MINT' ? job.payload.quantity : job.payload.amount, job.payload.wallet);
        await s.repo.tx(async (db) => {
            if (!(await s.repo.leased(db, job)))
                return;
            if (!proof) {
                if (job.kind === 'MINT') {
                    const order = await s.repo.order(db, job.orderId);
                    await s.repo.state(db, order, 'MINT_FINALITY_PENDING');
                }
                await s.repo.finish(db, job, 'SUBMITTED');
                return;
            }
            if (job.kind === 'MINT') {
                const order = await s.repo.order(db, job.orderId);
                ensure(['MINT_SUBMITTED', 'MINT_FINALITY_PENDING', 'MINT_UNKNOWN'].includes(order.state), 'MINT_ORDER_STATE_MISMATCH');
                await db.query('INSERT INTO arco_evm."StocksHolding" ("orderId","actorId",wallet,symbol,quantity,"deploymentId","txHash","blockHash","blockNumber","deploymentDigest") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [order.id, order.actorId, order.wallet, order.symbol, order.quantity, order.deploymentId, submission.txHash, proof.block.hash, proof.block.number, s.digest]);
                await s.repo.journal(db, `mint:${order.id}`, s.manifest.stockToken, 'CONFIRMED_ISSUED_SUPPLY', `WALLET:${order.wallet}`, order.quantity, proof.block.number);
                await s.repo.state(db, order, 'COMPLETED');
            }
            else {
                const funding = (await db.query('SELECT * FROM arco_evm."StocksFunding" WHERE id=$1 FOR UPDATE', [job.payload.fundingId])).rows[0];
                ensure(funding?.status === 'REFUND_PENDING', 'REFUND_STATE_MISMATCH');
                await s.repo.journal(db, `refund:${funding.id}`, s.manifest.cashToken, `SUSPENSE:${funding.id}`, 'CASH_VAULT', funding.amount, proof.block.number);
                await db.query('UPDATE arco_evm."StocksFunding" SET status=\'REFUNDED\' WHERE id=$1', [funding.id]);
                const order = await s.repo.order(db, job.orderId);
                if (['FUNDED_QUOTE_EXPIRED', 'FUNDING_REVIEW_REQUIRED'].includes(order.state)) {
                    const remaining = (await db.query(`SELECT id FROM arco_evm."StocksFunding" WHERE "orderId"=$1 AND payer=$2 AND status <> 'REFUNDED' LIMIT 1`, [order.id, order.wallet])).rows[0];
                    if (!remaining)
                        await s.repo.state(db, order, 'REFUNDED');
                }
            }
            await s.repo.audit(db, job.orderId, `${job.kind}_FINALIZED`, { operationId: job.id, txHash: submission.txHash, blockHash: proof.block.hash });
            await s.repo.finish(db, job, 'DONE');
        });
    }
}

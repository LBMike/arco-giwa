import { randomUUID } from 'node:crypto';
import { ensure, type SqlClient, type SqlPool } from './contracts.js';
export type Row = Record<string, any>;
export class StocksRepository {
    constructor(readonly pool: SqlPool, readonly deploymentDigest: string) { }
    async tx<T>(work: (db: SqlClient) => Promise<T>): Promise<T> {
        const db = await this.pool.connect();
        try {
            await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
            const result = await work(db);
            await db.query('COMMIT');
            return result;
        }
        catch (error) {
            await db.query('ROLLBACK');
            throw error;
        }
        finally {
            db.release();
        }
    }
    async audit(db: SqlClient, subject: string, action: string, detail: Row): Promise<void> {
        await db.query('INSERT INTO arco_evm."StocksAudit" (id,subject,action,detail,"deploymentDigest") VALUES ($1,$2,$3,$4,$5)', [randomUUID(), subject, action, JSON.stringify(detail), this.deploymentDigest]);
    }
    async journal(db: SqlClient, key: string, asset: string, debit: string, credit: string, value: string, blockNumber: string | null = null): Promise<void> {
        await db.query('INSERT INTO arco_evm."StocksJournal" (id,asset,debit,credit,amount,"deploymentDigest","blockNumber") VALUES ($1,$2,$3,$4,$5,$6,$7)', [key, asset, debit, credit, value, this.deploymentDigest, blockNumber]);
    }
    async enqueue(db: SqlClient, id: string, orderId: string | null, kind: string, payload: Row): Promise<void> {
        await db.query('INSERT INTO arco_evm."StocksOutbox" (id,"orderId",kind,payload,"deploymentDigest") VALUES ($1,$2,$3,$4,$5)', [id, orderId, kind, JSON.stringify(payload), this.deploymentDigest]);
    }
    async order(db: SqlClient, id: string): Promise<Row> {
        const row = (await db.query('SELECT * FROM arco_evm."StocksOrder" WHERE id=$1 AND "deploymentDigest"=$2 FOR UPDATE', [id, this.deploymentDigest])).rows[0];
        ensure(row, 'ORDER_NOT_FOUND', 404);
        return row;
    }
    async state(db: SqlClient, order: Row, state: string): Promise<void> {
        const result = await db.query('UPDATE arco_evm."StocksOrder" SET state=$1,version=version+1,"updatedAt"=clock_timestamp() WHERE id=$2 AND version=$3 AND "deploymentDigest"=$4', [state, order.id, order.version, this.deploymentDigest]);
        ensure(result.rowCount === 1, 'STALE_ORDER_VERSION', 409);
        await this.audit(db, order.id, state, { previous: order.state, version: order.version + 1 });
    }
    async claim(paused: boolean): Promise<Row | null> {
        return this.tx(async (db) => {
            const row = (await db.query(`SELECT * FROM arco_evm."StocksOutbox" WHERE "deploymentDigest"=$2 AND status IN ('PENDING','STARTED','UNKNOWN','SUBMITTED') AND ("leaseUntil" IS NULL OR "leaseUntil" < clock_timestamp()) AND (NOT $1 OR status <> 'PENDING') ORDER BY "nextAttemptAt", "createdAt", id FOR UPDATE SKIP LOCKED LIMIT 1`, [paused, this.deploymentDigest])).rows[0];
            if (!row || new Date(row.nextAttemptAt).getTime() > Date.now())
                return null;
            const lease = randomUUID();
            const originalStatus = row.status;
            await db.query(`UPDATE arco_evm."StocksOutbox" SET status=CASE WHEN status='PENDING' THEN 'STARTED' ELSE status END,"leaseId"=$2,"leaseUntil"=clock_timestamp()+interval '30 seconds',"nextAttemptAt"=clock_timestamp()+interval '1 second' WHERE id=$1`, [row.id, lease]);
            return { ...row, originalStatus, leaseId: lease };
        });
    }
    async leased(db: SqlClient, job: Row): Promise<boolean> {
        const row = (await db.query('SELECT * FROM arco_evm."StocksOutbox" WHERE id=$1 FOR UPDATE', [job.id])).rows[0];
        return row?.leaseId === job.leaseId && !['DONE', 'REVIEW'].includes(row.status);
    }
    async finish(db: SqlClient, job: Row, status: string, txHash: string | null = null): Promise<void> {
        const result = await db.query('UPDATE arco_evm."StocksOutbox" SET status=$1,"txHash"=COALESCE($2,"txHash"),"leaseId"=NULL,"leaseUntil"=NULL WHERE id=$3 AND "leaseId"=$4', [status, txHash, job.id, job.leaseId]);
        ensure(result.rowCount === 1, 'STALE_WORKER_LEASE', 409);
    }
    async scopedOrders(actorId: string, id?: string): Promise<Row[]> {
        return (await this.pool.query('SELECT * FROM arco_evm."StocksOrder" WHERE "actorId"=$1 AND "deploymentDigest"=$3 AND ($2::text IS NULL OR id=$2) ORDER BY "createdAt" DESC LIMIT 100', [actorId, id ?? null, this.deploymentDigest])).rows;
    }
    async portfolio(actorId: string): Promise<Row> {
        const [holdings, pending] = await Promise.all([
            this.pool.query('SELECT "deploymentId",wallet,symbol,SUM(quantity)::text AS quantity FROM arco_evm."StocksHolding" WHERE "actorId"=$1 AND "deploymentDigest"=$2 GROUP BY "deploymentId",wallet,symbol', [actorId, this.deploymentDigest]),
            this.pool.query(`SELECT id,state,quantity::text,"cashAmount"::text FROM arco_evm."StocksOrder" WHERE "actorId"=$1 AND "deploymentDigest"=$2 AND state NOT IN ('COMPLETED','REFUNDED') ORDER BY "createdAt"`, [actorId, this.deploymentDigest]),
        ]);
        return { holdings: holdings.rows, pending: pending.rows, projectionPolicy: 'FINALIZED_RESTRICTED_TRANSFER_ISSUANCE_ONLY' };
    }
    async adminOrder(id: string): Promise<Row | null> {
        const order = (await this.admin('orders', id))[0];
        if (!order)
            return null;
        const [funding, operations, audit, holdings] = await Promise.all([
            this.pool.query('SELECT * FROM arco_evm."StocksFunding" WHERE "orderId"=$1 AND "deploymentDigest"=$2 ORDER BY "createdAt",id', [id, this.deploymentDigest]),
            this.pool.query('SELECT id,kind,status,"txHash","createdAt","leaseUntil" FROM arco_evm."StocksOutbox" WHERE "orderId"=$1 AND "deploymentDigest"=$2 ORDER BY "createdAt",id', [id, this.deploymentDigest]),
            this.pool.query('SELECT * FROM arco_evm."StocksAudit" WHERE subject=$1 AND "deploymentDigest"=$2 ORDER BY "createdAt",id', [id, this.deploymentDigest]),
            this.pool.query('SELECT * FROM arco_evm."StocksHolding" WHERE "orderId"=$1 AND "deploymentDigest"=$2', [id, this.deploymentDigest]),
        ]);
        return { order, funding: funding.rows, operations: operations.rows, audit: audit.rows, holdings: holdings.rows };
    }
    async admin(kind: 'overview' | 'orders' | 'reconciliations' | 'audit', id?: string): Promise<Row[]> {
        if (kind === 'orders')
            return (await this.pool.query('SELECT * FROM arco_evm."StocksOrder" WHERE "deploymentDigest"=$2 AND ($1::text IS NULL OR id=$1) ORDER BY "createdAt" DESC LIMIT 200', [id ?? null, this.deploymentDigest])).rows;
        if (kind === 'overview')
            return (await this.pool.query('SELECT state,COUNT(*)::text AS count,SUM("cashAmount")::text AS "cashAmount" FROM arco_evm."StocksOrder" WHERE "deploymentDigest"=$1 GROUP BY state', [this.deploymentDigest])).rows;
        if (kind === 'audit')
            return (await this.pool.query('SELECT * FROM arco_evm."StocksAudit" WHERE "deploymentDigest"=$1 ORDER BY "createdAt" DESC,id LIMIT 200', [this.deploymentDigest])).rows;
        return (await this.pool.query(`SELECT 'ORDER' AS kind,id,state AS status FROM arco_evm."StocksOrder" WHERE "deploymentDigest"=$1 AND state NOT IN ('COMPLETED','REFUNDED') UNION ALL SELECT 'FUNDING',id,status FROM arco_evm."StocksFunding" WHERE "deploymentDigest"=$1 AND status IN ('SUSPENSE','REFUND_PENDING') UNION ALL SELECT 'OUTBOX',id,status FROM arco_evm."StocksOutbox" WHERE "deploymentDigest"=$1 AND status <> 'DONE' ORDER BY kind,id`, [this.deploymentDigest])).rows;
    }
}

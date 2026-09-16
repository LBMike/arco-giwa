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
    async isTransactionProjected(txHash: string): Promise<boolean> {
        const row = (await this.pool.query(`SELECT o.id FROM arco_evm."StocksOutbox" o WHERE o."deploymentDigest"=$1 AND o."txHash"=$2 AND o.status='DONE' AND o.kind IN('MINT','REFUND','REDEEM','RETURN') AND EXISTS(SELECT 1 FROM arco_evm."StocksAudit" a WHERE a."deploymentDigest"=$1 AND a.action=o.kind||'_FINALIZED' AND a.detail->>'txHash'=$2) LIMIT 1`, [this.deploymentDigest, txHash])).rows[0];
        return !!row;
    }
    async walletPosition(db: Pick<SqlClient, 'query'>, wallet: string) {
        const row = (await db.query(`SELECT
          (SELECT COALESCE(SUM(quantity),0) FROM arco_evm."StocksHolding" WHERE "deploymentDigest"=$1 AND wallet=$2)+
          (SELECT COALESCE(SUM("walletDelta"),0) FROM arco_evm."StocksQuantityMovement" WHERE "deploymentDigest"=$1 AND wallet=$2) AS wallet,
          (SELECT COALESCE(SUM("escrowDelta"),0) FROM arco_evm."StocksQuantityMovement" WHERE "deploymentDigest"=$1 AND wallet=$2) AS escrow,
          (SELECT COALESCE(SUM(quantity),0) FROM arco_evm."StocksQuantityReservation" WHERE "deploymentDigest"=$1 AND wallet=$2 AND status='ACTIVE') AS reserved`, [this.deploymentDigest, wallet])).rows[0];
        return { walletQuantity: String(row.wallet), escrowedQuantity: String(row.escrow), reservedQuantity: String(row.reserved), availableQuantity: (BigInt(row.wallet) - BigInt(row.reserved)).toString(), quantity: (BigInt(row.wallet) + BigInt(row.escrow)).toString() };
    }
    async liquidity(db: Pick<SqlClient, 'query'>, cashToken: string) {
        const row = (await db.query(`SELECT
         (SELECT COALESCE(SUM(CASE WHEN debit='CASH_VAULT' THEN amount WHEN credit='CASH_VAULT' THEN -amount ELSE 0 END),0) FROM arco_evm."StocksJournal" WHERE "deploymentDigest"=$1 AND asset=$2) AS "cashBalance",
         (SELECT COALESCE(SUM(f.amount),0) FROM arco_evm."StocksFunding" f LEFT JOIN arco_evm."StocksOrder" o ON o.id=f."orderId" WHERE f."deploymentDigest"=$1 AND (f.status IN('SUSPENSE','REFUND_PENDING') OR (f.status='ACCEPTED' AND o.state<>'COMPLETED'))) AS liabilities,
         (SELECT COALESCE(SUM(amount),0) FROM arco_evm."StocksCashReservation" WHERE "deploymentDigest"=$1 AND status='RESERVED') AS "sellReserved"`, [this.deploymentDigest, cashToken])).rows[0];
        return { cashBalance: String(row.cashBalance), liabilities: String(row.liabilities), sellReserved: String(row.sellReserved) };
    }
    async sellOrders(actorId: string, id?: string) { return (await this.pool.query(`SELECT *,'SELL' AS side FROM arco_evm."StocksSellOrder" WHERE "actorId"=$1 AND "deploymentDigest"=$2 AND ($3::text IS NULL OR id=$3) ORDER BY "createdAt" DESC LIMIT 100`, [actorId, this.deploymentDigest, id ?? null])).rows; }
    async portfolio(actorId: string): Promise<Row> {
        const wallets = (await this.pool.query(`SELECT wallet FROM arco_evm."StocksHolding" WHERE "actorId"=$1 AND "deploymentDigest"=$2 UNION SELECT wallet FROM arco_evm."StocksSellOrder" WHERE "actorId"=$1 AND "deploymentDigest"=$2`, [actorId, this.deploymentDigest])).rows;
        const holdings = [];
        for (const row of wallets)
            holdings.push({ wallet: row.wallet, symbol: 'NVDA', ...await this.walletPosition(this.pool, row.wallet) });
        const pending = (await this.pool.query(`SELECT id,state,quantity::text,"cashAmount"::text,'BUY' AS side FROM arco_evm."StocksOrder" WHERE "actorId"=$1 AND "deploymentDigest"=$2 AND state NOT IN('COMPLETED','REFUNDED') UNION ALL SELECT id,state,quantity::text,"cashAmount"::text,'SELL' AS side FROM arco_evm."StocksSellOrder" WHERE "actorId"=$1 AND "deploymentDigest"=$2 AND state NOT IN('COMPLETED','RETURNED','EXPIRED')`, [actorId, this.deploymentDigest])).rows;
        return { holdings, pending, projectionPolicy: 'FINALIZED_RESTRICTED_TRANSFER_MOVEMENTS' };
    }
    async adminOrder(id: string): Promise<Row | null> {
        const order = (await this.admin('orders', id))[0];
        if (!order)
            return null;
        if (order.side === 'SELL') {
            const custody = (await this.pool.query('SELECT * FROM arco_evm."StocksCustody" WHERE "orderId"=$1 AND "deploymentDigest"=$2', [id, this.deploymentDigest])).rows;
            const operations = (await this.pool.query('SELECT id,kind,status,"txHash","createdAt" FROM arco_evm."StocksOutbox" WHERE "sellOrderId"=$1 AND "deploymentDigest"=$2', [id, this.deploymentDigest])).rows;
            const audit = (await this.pool.query('SELECT * FROM arco_evm."StocksAudit" WHERE subject=$1 AND "deploymentDigest"=$2 ORDER BY "createdAt",id', [id, this.deploymentDigest])).rows;
            const reservations = (await this.pool.query('SELECT * FROM arco_evm."StocksCashReservation" WHERE "orderId"=$1 AND "deploymentDigest"=$2', [id, this.deploymentDigest])).rows;
            return { order, custody, operations, audit, reservations };
        }
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
            return (await this.pool.query(`SELECT *,'BUY' AS side FROM arco_evm."StocksOrder" WHERE "deploymentDigest"=$2 AND ($1::text IS NULL OR id=$1) UNION ALL SELECT *,'SELL' AS side FROM arco_evm."StocksSellOrder" WHERE "deploymentDigest"=$2 AND ($1::text IS NULL OR id=$1) ORDER BY "createdAt" DESC LIMIT 200`, [id ?? null, this.deploymentDigest])).rows;
        if (kind === 'overview')
            return (await this.pool.query(`SELECT state,COUNT(*)::text AS count,SUM("cashAmount")::text AS "cashAmount",'BUY' AS side FROM arco_evm."StocksOrder" WHERE "deploymentDigest"=$1 GROUP BY state UNION ALL SELECT state,COUNT(*)::text AS count,SUM("cashAmount")::text AS "cashAmount",'SELL' AS side FROM arco_evm."StocksSellOrder" WHERE "deploymentDigest"=$1 GROUP BY state`, [this.deploymentDigest])).rows;
        if (kind === 'audit')
            return (await this.pool.query('SELECT * FROM arco_evm."StocksAudit" WHERE "deploymentDigest"=$1 ORDER BY "createdAt" DESC,id LIMIT 200', [this.deploymentDigest])).rows;
        return (await this.pool.query(`SELECT 'ORDER' AS kind,id,state AS status FROM arco_evm."StocksOrder" WHERE "deploymentDigest"=$1 AND state NOT IN ('COMPLETED','REFUNDED') UNION ALL SELECT 'FUNDING',id,status FROM arco_evm."StocksFunding" WHERE "deploymentDigest"=$1 AND status IN ('SUSPENSE','REFUND_PENDING') UNION ALL SELECT 'OUTBOX',id,status FROM arco_evm."StocksOutbox" WHERE "deploymentDigest"=$1 AND status <> 'DONE' UNION ALL SELECT 'SELL',id,state FROM arco_evm."StocksSellOrder" WHERE "deploymentDigest"=$1 AND state NOT IN('COMPLETED','RETURNED','EXPIRED') UNION ALL SELECT 'CUSTODY',id,status FROM arco_evm."StocksCustody" WHERE "deploymentDigest"=$1 AND status NOT IN('REDEEMED','RETURNED') ORDER BY kind,id`, [this.deploymentDigest])).rows;
    }
}

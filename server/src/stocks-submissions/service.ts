import { orderBinding } from './enrollment.js';
import { randomUUID } from 'node:crypto';
import { address, ensure, immutable, validateActor, type Actor, type SqlClient } from '../stocks/contracts.js';
import type { Row } from '../stocks/repository.js';
import type { StocksService } from '../stocks/service.js';
import { deriveOrder, digest, exact, hashDigest, label, output, side, stage, type Side, type AttemptRecord } from './contracts.js';

export class StocksSubmissionsService {
  constructor(readonly stocks: StocksService) {}
  private async order(db: SqlClient, actor: Actor, orderSide: Side, id: string): Promise<Row> {
    const table = orderSide === 'BUY' ? 'StocksOrder' : 'StocksSellOrder';
    const row = (await db.query(`SELECT *,"quoteExpiresAt">clock_timestamp() AS valid FROM arco_evm."${table}" WHERE id=$1 AND "deploymentDigest"=$2 FOR UPDATE`, [id, this.stocks.digest])).rows[0];
    ensure(row && row.actorId === actor.actorId && address(row.wallet) === address(actor.wallet), 'ORDER_NOT_FOUND', 404);
    ensure(row.deploymentId === this.stocks.manifest.deploymentId, 'ORDER_DEPLOYMENT_MISMATCH', 409);
    return row;
  }
  private actor(input: Actor): Actor { const actor = immutable(input); validateActor(actor); return actor; }
  private binding(row: Row, actor: Actor, order: Row, orderSide: Side): void {
    ensure(row.actorId === actor.actorId && row.wallet === address(actor.wallet) && row.orderId === order.id && row.side === orderSide && row.deploymentDigest === this.stocks.digest, 'SUBMISSION_SCOPE_MISMATCH', 409);
  }
  async inspect(input: Actor, rawSide: unknown, rawOrderId: unknown) {
    const actor = this.actor(input), orderSide = side(rawSide), id = label(rawOrderId);
    return this.stocks.repo.tx(async db => {
      const order = await this.order(db, actor, orderSide, id), plan = deriveOrder(this.stocks.manifest, order, orderSide);
      const rows = (await db.query('SELECT * FROM arco_evm."StocksWalletSubmission" WHERE "intentKey"=$1 ORDER BY stage', [plan.intentKey])).rows;
      for (const row of rows) this.binding(row, actor, order, orderSide);
      return { intentKey: plan.intentKey, approval: rows.find(r => r.stage === 'APPROVAL') ? output(rows.find(r => r.stage === 'APPROVAL')!) : null, transfer: rows.find(r => r.stage === 'TRANSFER') ? output(rows.find(r => r.stage === 'TRANSFER')!) : null };
    });
  }
  async claim(input: Actor, raw: unknown): Promise<AttemptRecord | null> {
    const actor = this.actor(input), body = immutable(exact(raw, ['side', 'orderId', 'intentKey', 'stage', 'transactionDigest', 'transaction', 'deploymentDigest']));
    const orderSide = side(body.side), id = label(body.orderId), requestedStage = stage(body.stage);
    hashDigest(body.intentKey); hashDigest(body.transactionDigest); hashDigest(body.deploymentDigest);
    exact(body.transaction, ['chainId', 'from', 'to', 'data', 'value']);
    await this.stocks.ready();
    return this.stocks.repo.tx(async db => {
      const order = await this.order(db, actor, orderSide, id), plan = deriveOrder(this.stocks.manifest, order, orderSide);
      const enrollment = (await db.query('SELECT * FROM arco_evm."StocksWalletSubmissionEnrollment" WHERE side=$1 AND "orderId"=$2', [orderSide, id])).rows[0];
      ensure(enrollment && enrollment.intentKey === plan.intentKey && enrollment.actorId === actor.actorId && enrollment.wallet === address(actor.wallet) && enrollment.deploymentDigest === this.stocks.digest && enrollment.orderBinding === orderBinding(order, orderSide), 'SUBMISSION_NOT_ENROLLED', 409);
      const transaction = requestedStage === 'APPROVAL' ? plan.approval : plan.transfer;
      ensure(body.deploymentDigest === this.stocks.digest && body.intentKey === plan.intentKey && body.transactionDigest === digest(transaction) && digest(body.transaction) === digest(transaction), 'SUBMISSION_BINDING_MISMATCH', 409);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`wallet-submission:${plan.intentKey}`]);
      const prior = (await db.query('SELECT * FROM arco_evm."StocksWalletSubmission" WHERE "intentKey"=$1 FOR UPDATE', [plan.intentKey])).rows;
      // A prior physical claim blocks even if an actor/deployment alias differs.
      if (prior.some(row => row.stage === requestedStage)) return null;
      ensure(prior.length === 0, 'SUBMISSION_STAGE_BLOCKED', 409);
      ensure(!(await this.stocks.paused()), 'STOCKS_PAUSED', 503);
      ensure(order.state === (orderSide === 'BUY' ? 'AWAITING_FUNDING' : 'AWAITING_ESCROW'), 'ORDER_NOT_PAYABLE', 409);
      // Re-evaluate on the DB clock after waiting for all locks and pause checks.
      const timely = (await db.query('SELECT $1::timestamptz>clock_timestamp() AS valid', [order.quoteExpiresAt])).rows[0];
      ensure(timely.valid, 'ORDER_EXPIRED', 409);
      const row = (await db.query(`INSERT INTO arco_evm."StocksWalletSubmission" ("claimId","intentKey",stage,"transactionDigest",transaction,"actorId",wallet,side,"orderId","deploymentDigest",status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'REQUEST_MAY_START') ON CONFLICT("intentKey",stage) DO NOTHING RETURNING *`, [randomUUID(), plan.intentKey, requestedStage, digest(transaction), JSON.stringify(transaction), actor.actorId, address(actor.wallet), orderSide, id, this.stocks.digest])).rows[0];
      if (!row) return null;
      await this.stocks.repo.audit(db, id, 'WALLET_SUBMISSION_CLAIMED', { claimId: row.claimId, intentKey: plan.intentKey, stage: requestedStage, transactionDigest: row.transactionDigest });
      return output(row);
    });
  }
  async record(input: Actor, raw: unknown): Promise<AttemptRecord> {
    const actor = this.actor(input);
    ensure(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'INVALID_SUBMISSION_INPUT');
    const body = immutable(exact(raw, ['claimId', 'intentKey', 'stage', 'transactionDigest', 'status', ...(Object.prototype.hasOwnProperty.call(raw, 'txHash') ? ['txHash'] : [])]));
    label(body.claimId); hashDigest(body.intentKey); hashDigest(body.transactionDigest); stage(body.stage);
    ensure(body.status !== 'CONFIRMED' && body.status !== 'REVERTED', 'RECEIPT_VERIFICATION_REQUIRED', 409);
    ensure(body.status === 'UNKNOWN' || body.status === 'SUBMITTED', 'INVALID_SUBMISSION_STATUS');
    if (body.txHash !== undefined) ensure(typeof body.txHash === 'string' && /^0x[0-9a-f]{64}$/.test(body.txHash) && !/^0x0{64}$/.test(body.txHash), 'INVALID_SUBMISSION_HASH');
    ensure(body.status !== 'SUBMITTED' || body.txHash !== undefined, 'INVALID_SUBMISSION_HASH');
    return this.stocks.repo.tx(async db => {
      const found = (await db.query('SELECT * FROM arco_evm."StocksWalletSubmission" WHERE "claimId"=$1 AND "actorId"=$2 AND wallet=$3 AND "deploymentDigest"=$4', [body.claimId, actor.actorId, address(actor.wallet), this.stocks.digest])).rows[0];
      ensure(found, 'SUBMISSION_NOT_FOUND', 404);
      const order = await this.order(db, actor, side(found.side), found.orderId);
      const plan = deriveOrder(this.stocks.manifest, order, side(found.side));
      const row = (await db.query('SELECT * FROM arco_evm."StocksWalletSubmission" WHERE "claimId"=$1 FOR UPDATE', [body.claimId])).rows[0];
      this.binding(row, actor, order, side(found.side));
      ensure(row.intentKey === plan.intentKey && row.intentKey === body.intentKey && row.stage === body.stage && row.transactionDigest === body.transactionDigest, 'SUBMISSION_BINDING_MISMATCH', 409);
      ensure(!row.txHash || !body.txHash || row.txHash === body.txHash, 'SUBMISSION_HASH_CONFLICT', 409);
      const status = row.status === 'SUBMITTED' ? 'SUBMITTED' : body.status;
      const txHash = row.txHash ?? body.txHash ?? null;
      if (status === row.status && txHash === row.txHash) return output(row);
      const updated = (await db.query('UPDATE arco_evm."StocksWalletSubmission" SET status=$2,"txHash"=$3,"updatedAt"=clock_timestamp() WHERE "claimId"=$1 RETURNING *', [row.claimId, status, txHash])).rows[0];
      await this.stocks.repo.audit(db, order.id, 'WALLET_SUBMISSION_OBSERVED', { claimId: row.claimId, status, txHash });
      return output(updated);
    });
  }
}

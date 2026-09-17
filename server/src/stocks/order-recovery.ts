import { address, ensure, immutable, validateActor, type Actor } from './contracts.js';
import type { StocksRepository, Row } from './repository.js';

// Recovery is a committed-row lookup, never a new order or execution permission.
// It deliberately does not call ready(): pauses/expired quotes must not hide a
// previously committed order after its creation response was lost.
export async function recoverOrder(repo: StocksRepository, actor: Actor, side: 'BUY' | 'SELL', quoteId: string, key: string): Promise<Row> {
    actor = immutable(actor);
    validateActor(actor);
    ensure(side === 'BUY' || side === 'SELL', 'INVALID_ORDER_REQUEST');
    ensure(typeof quoteId === 'string' && quoteId.length > 0 && quoteId.length <= 128 && typeof key === 'string' && /^[a-zA-Z0-9:_-]{8,128}$/.test(key), 'INVALID_ORDER_REQUEST');
    const table = side === 'BUY' ? 'StocksOrder' : 'StocksSellOrder';
    const row = (await repo.pool.query(`SELECT * FROM arco_evm."${table}" WHERE "actorId"=$1 AND wallet=$2 AND "deploymentDigest"=$3 AND "idempotencyKey"=$4`, [actor.actorId, address(actor.wallet), repo.deploymentDigest, key])).rows[0];
    ensure(row, 'ORDER_NOT_FOUND', 404);
    ensure(row.quoteId === quoteId, 'IDEMPOTENCY_CONFLICT', 409);
    return { ...row, side };
}

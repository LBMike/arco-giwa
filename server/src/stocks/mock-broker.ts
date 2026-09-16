import { createHash } from 'node:crypto';
import { amount, ensure, type BrokerPort, type BrokerRequest, type BrokerResult } from './contracts.js';
import { StocksRepository } from './repository.js';
// Explicit demo-only adapter. Its durable provider receipt is committed in its OWN transaction,
// outside the order worker transaction, so lookup resolves a crash after provider acceptance.
export function createDurableMockBroker(repo: StocksRepository): BrokerPort {
    return {
        async submit(request: BrokerRequest): Promise<BrokerResult> {
            ensure(request.symbol === 'NVDA' && request.operationId === `broker:${request.orderId}`, 'INVALID_MOCK_ORDER');
            amount(request.quantity);
            amount(request.cashAmount);
            const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
            return repo.tx(async (db) => {
                await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`mock-provider:${request.operationId}`]);
                const existing = (await db.query('SELECT * FROM arco_evm."StocksProviderReceipt" WHERE id=$1', [request.operationId])).rows[0];
                if (existing) {
                    ensure(existing.requestDigest === digest && existing.deploymentDigest === repo.deploymentDigest, 'MOCK_REQUEST_CONFLICT');
                    return existing.result;
                }
                const result: BrokerResult = { operationId: request.operationId, outcome: 'FILLED', quantity: request.quantity, cashAmount: request.cashAmount, mode: 'MOCK_BROKER' };
                await db.query('INSERT INTO arco_evm."StocksProviderReceipt" (id,"deploymentDigest","requestDigest",result) VALUES ($1,$2,$3,$4)', [request.operationId, repo.deploymentDigest, digest, JSON.stringify(result)]);
                return result;
            });
        },
        async lookup(id: string): Promise<BrokerResult | null> {
            return (await repo.pool.query('SELECT result FROM arco_evm."StocksProviderReceipt" WHERE id=$1 AND "deploymentDigest"=$2', [id, repo.deploymentDigest])).rows[0]?.result ?? null;
        },
    };
}

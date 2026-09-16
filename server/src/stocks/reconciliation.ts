import { StocksService } from './service.js';
export type ReconciliationCoverage = {
    deploymentDigest: string;
    throughBlock: string;
    blockHash: string;
    observedAt: string;
};
export type CoveragePort = () => Promise<ReconciliationCoverage | null>;
// Coverage must come from the trusted observer after all finalized relevant logs through the
// cutoff have been ingested. An absent cursor is explicitly INCOMPLETE, never a green result.
export async function reconcileStocks(service: StocksService, coverage?: CoveragePort) {
    const pending = await service.repo.admin('reconciliations');
    if (!coverage)
        return { status: 'UNAVAILABLE', reason: 'NO_FINALIZED_OBSERVER_COVERAGE', pending };
    const cursor = await coverage();
    if (!cursor || cursor.deploymentDigest !== service.digest)
        return { status: 'INCOMPLETE', reason: 'OBSERVER_DEPLOYMENT_OR_COVERAGE_MISSING', pending };
    const observed = Date.parse(cursor.observedAt);
    if (!Number.isFinite(observed) || observed > Date.now() + 5000 || Date.now() - observed > 60000)
        return { status: 'INCOMPLETE', reason: 'STALE_OR_INVALID_OBSERVER_COVERAGE', cutoff: cursor, pending };
    if (!/^(0|[1-9]\d*)$/.test(cursor.throughBlock) || !/^0x[0-9a-f]{64}$/.test(cursor.blockHash))
        return { status: 'INCOMPLETE', reason: 'INVALID_CUTOFF', pending };
    const walletRows = (await service.repo.pool.query('SELECT wallet,SUM(quantity)::text AS quantity FROM arco_evm."StocksHolding" WHERE "deploymentDigest"=$1 AND "blockNumber"<=$2 GROUP BY wallet', [service.digest, cursor.throughBlock])).rows;
    let snapshot;
    try {
        snapshot = await service.verifier.snapshot(cursor.throughBlock, cursor.blockHash, walletRows.map(row => row.wallet));
    }
    catch {
        return { status: 'UNAVAILABLE', reason: 'FINALIZED_SNAPSHOT_UNVERIFIED', pending };
    }
    if (!snapshot)
        return { status: 'INCOMPLETE', reason: 'CUTOFF_NOT_CANONICAL_FINALIZED', pending };
    const row = (await service.repo.pool.query(`SELECT COALESCE(SUM(CASE WHEN debit='CASH_VAULT' THEN amount WHEN credit='CASH_VAULT' THEN -amount ELSE 0 END),0)::text AS cash FROM arco_evm."StocksJournal" WHERE "deploymentDigest"=$1 AND asset=$2 AND "blockNumber"<=$3`, [service.digest, service.manifest.cashToken, cursor.throughBlock])).rows[0];
    const expectedSupply = walletRows.reduce((sum, holding) => sum + BigInt(holding.quantity), 0n).toString();
    const differences = [];
    if (snapshot.cashBalance !== row.cash)
        differences.push({ asset: 'TEST_CASH', expected: row.cash, actual: snapshot.cashBalance });
    if (snapshot.stockSupply !== expectedSupply)
        differences.push({ asset: 'STOCK_SUPPLY', expected: expectedSupply, actual: snapshot.stockSupply });
    for (const holding of walletRows)
        if (snapshot.walletBalances[holding.wallet] !== holding.quantity)
            differences.push({ asset: 'STOCK_WALLET', wallet: holding.wallet, expected: holding.quantity, actual: snapshot.walletBalances[holding.wallet] });
    return { status: differences.length ? 'MISMATCH' : 'MATCHED_AT_CUTOFF', cutoff: cursor, snapshot, differences, pending };
}

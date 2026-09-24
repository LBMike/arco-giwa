// TEST_HARNESS_ONLY subprocess crash probe. Never imported by runtime composition.
import { createRequire } from 'node:module';
import { manifestDigest, type Manifest, type SqlPool } from './contracts.js';
import { StocksRepository } from './repository.js';
import { createDurableMockBroker } from './mock-broker.js';
if (process.env.STOCKS_TEST_HARNESS_ONLY !== '1' || !process.env.STOCKS_TEST_DATABASE_URL || !process.env.STOCKS_CRASH_MANIFEST)
    throw new Error('TEST_HARNESS_ONLY');
const require = createRequire(import.meta.url);
const { Pool } = require('pg') as {
    Pool: new (options: unknown) => SqlPool;
};
const manifest = JSON.parse(process.env.STOCKS_CRASH_MANIFEST) as Manifest;
const pool = new Pool({ connectionString: process.env.STOCKS_TEST_DATABASE_URL, max: 1 });
const repo = new StocksRepository(pool, manifestDigest(manifest));
const job = await repo.claim(false);
if (!job || !['BROKER', 'SELL_BROKER'].includes(job.kind) || job.originalStatus !== 'PENDING')
    throw new Error('INVALID_CRASH_PROBE_JOB');
await createDurableMockBroker(repo).submit(job.payload);
// The external provider effect is durable; the core order/outbox result has not been committed.
process.kill(process.pid, 'SIGKILL');

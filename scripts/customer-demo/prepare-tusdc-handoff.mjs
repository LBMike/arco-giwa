import { join } from 'node:path';
import { readFile, lstat } from 'node:fs/promises';
import pg from 'pg';
import { readStocksPublicJson } from '../../server/dist/stocks-runtime/public-config.js';
import { LOCAL_CUSTOMER_MANIFEST, LOCAL_CUSTOMER_TUSDC_MANIFEST, LOCAL_CUSTOMER_RPC } from '../../server/dist/stocks-runtime/local-customer.js';
import { httpStocksRpc } from '../../server/dist/stocks-runtime/transport.js';
import { httpStocksSignerRpc } from '../../server/dist/stocks-signer/http-rpc.js';
import { parseExternalCashHandoffPlan, verifyExternalCashHandoff, requireEmptyPriorStocksEpoch,
  seedExternalCashJournal, TUSDC_JOURNAL_DATABASE } from '../../server/dist/stocks-signer/external-cash-handoff.js';
import { readLocalCustomerServerConfig, localCustomerEnvironment } from './local-environment.mjs';
import { prepareSignerDatabase, acquireLocalDemoLock, exclusiveJson, root } from './local-operations.mjs';
import { handoffNames, tusdcJournalConnection } from './tusdc-handoff.mjs';

// Explicit, post-deployment preparation. No key/custody import, transaction send,
// old journal mutation, operator resume, API start or runtime.json replacement.
const base = '/Users/whdqkf88/Desktop/arco-giwa/GIWA_LOCAL_DEMO_20260924';
let release, storage, prior, next, product, admin;
try {
  if (process.argv.length !== 3 || process.argv[2] !== '--prepare'
    || !LOCAL_CUSTOMER_TUSDC_MANIFEST) throw Error('TUSDC_PREPARATION_NOT_REVIEWED');
  release = await acquireLocalDemoLock();
  const existing = await lstat(join(base, 'private/signer-postgres/provisioned.json'));
  if (!existing.isFile() || existing.isSymbolicLink()) throw Error('TUSDC_PRIOR_JOURNAL_REQUIRED');
  const plan = parseExternalCashHandoffPlan(await readStocksPublicJson(join(base, handoffNames.plan)), {
    priorManifestDigest: LOCAL_CUSTOMER_MANIFEST, manifestDigest: LOCAL_CUSTOMER_TUSDC_MANIFEST,
  });
  const server = localCustomerEnvironment(await readLocalCustomerServerConfig(join(base, 'private/server.json')), join(base, 'runtime.json'));
  storage = await prepareSignerDatabase(join(base, 'private'));
  const pool = connectionString => { const value = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 10000 }); value.on('error', () => {}); return value; };
  prior = pool(storage.connectionString); product = pool(server.DATABASE_URL);
  const readRpc = httpStocksRpc(LOCAL_CUSTOMER_RPC), signerRpc = httpStocksSignerRpc(LOCAL_CUSTOMER_RPC);
  const rpc = (method, params) => method === 'eth_getTransactionCount' ? signerRpc(method, params) : readRpc(method, params);
  const verify = () => verifyExternalCashHandoff({ plan, priorJournal: prior, rpc,
    requirePriorEpoch: () => requireEmptyPriorStocksEpoch(product, LOCAL_CUSTOMER_MANIFEST) });
  const verified = await verify();
  const nextConnection = tusdcJournalConnection(storage.connectionString);
  const adminUrl = new URL(storage.connectionString); adminUrl.pathname = '/postgres';
  admin = pool(adminUrl.toString());
  const found = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [TUSDC_JOURNAL_DATABASE]);
  // Fixed identifier, never user input. Restart completes only this separate database.
  if (!found.rowCount) await admin.query('CREATE DATABASE arco_signer_tusdc_025');
  next = pool(nextConnection);
  const tables = (await next.query("SELECT to_regclass('stocks_signer.account_nonce') AS account, to_regclass('stocks_signer.signed_intent') AS intent")).rows[0];
  if (!tables.account) {
    const client = await next.connect();
    try {
      await client.query('BEGIN');
      await client.query(await readFile(join(root, 'server/src/stocks-signer/migrations/0001_journal.sql'), 'utf8'));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  if (!tables.intent) await next.query(await readFile(join(root, 'server/src/stocks-signer/migrations/0002_signed_intent.sql'), 'utf8'));
  // Repeat canonical chain/old epoch checks directly before the atomic new seed.
  const fresh = await verify();
  if (fresh.oldJournalDigest !== verified.oldJournalDigest) throw Error('TUSDC_PRIOR_JOURNAL_CHANGED');
  await seedExternalCashJournal({ plan, evidence: fresh, priorJournal: prior, journal: next });
  const evidencePath = join(base, 'private', handoffNames.evidence);
  let exists = false; try { await lstat(evidencePath); exists = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (exists) {
    const saved = await readStocksPublicJson(evidencePath);
    // A later finalized tip is normal; stable handoff facts and original evidence remain immutable.
    for (const key of ['schemaVersion','planDigest','priorManifestDigest','manifestDigest','priorInitialNonce','priorNextNonce','initialNonce','oldJournalDigest']) {
      if (saved[key] !== fresh[key]) throw Error('TUSDC_HANDOFF_EVIDENCE_CONFLICT');
    }
  } else {
    // Public evidence, kept under private ownership until the integrator pins it in the bundle.
    await exclusiveJson(evidencePath, fresh);
  }
  console.log('TUSDC_HANDOFF_PREPARED — 기존 정산 기록 유지. 새 런타임·지갑 서명은 시작하지 않았습니다.');
} catch {
  console.error('TUSDC_HANDOFF_PREPARATION_FAILED — 기존 기록을 보존했습니다. 승인된 배포·이전 거래 종료·별도 정산 기록을 확인하세요.');
  process.exitCode = 1;
} finally {
  await Promise.allSettled([prior?.end(), next?.end(), product?.end(), admin?.end()]);
  if (storage?.started) await storage.stop().catch(() => { process.exitCode = 1; });
  await release?.();
}

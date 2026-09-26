import { isAbsolute } from 'node:path';
import pg from 'pg';
import { readStocksPublicJson } from '../../server/dist/stocks-runtime/public-config.js';
import { parseSignerHostConfig } from '../../server/dist/stocks-signer/host-config.js';
import { httpStocksSignerRpc } from '../../server/dist/stocks-signer/http-rpc.js';
import { seedSignerJournal, signerJournalStatus } from '../../server/dist/stocks-signer/journal-seed.js';
import { giwaConfirmedTransport } from '../../server/dist/stocks/giwa-confirmation.js';

// Operator tool for the hosted signer's journal. --status is read-only. --seed writes the
// single account row at the reviewed starting nonce, which must also be the config's
// reviewedInitialNonce. Output is public data only (addresses and nonces).
//   node scripts/stocks-signer/journal.mjs --config /etc/secrets/stocks-signer.json --status
//   node scripts/stocks-signer/journal.mjs --config /etc/secrets/stocks-signer.json --seed <nonce>
const args = process.argv.slice(2);
let pool, stage = 'ARGUMENTS';
try {
  const status = args.length === 3 && args[2] === '--status';
  const seed = args.length === 4 && args[2] === '--seed';
  if (args[0] !== '--config' || !isAbsolute(args[1] ?? '') || !(status || seed)) throw Error('INVALID_ARGUMENTS');
  stage = 'ENVIRONMENT';
  const connectionString = process.env.STOCKS_SIGNER_DATABASE_URL;
  if (!connectionString || connectionString.length > 4096 || !/^postgres(?:ql)?:\/\//.test(connectionString))
    throw Error('MISSING_SERVER_CONFIGURATION');
  stage = 'CONFIG';
  const config = parseSignerHostConfig(await readStocksPublicJson(args[1]));
  if (seed && args[3] !== config.reviewedInitialNonce) throw Error('SEED_NONCE_NOT_REVIEWED_IN_CONFIG');
  stage = status ? 'STATUS' : 'SEED';
  pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000, query_timeout: 6_000, idleTimeoutMillis: 1_000 });
  pool.on('error', () => process.stderr.write('SIGNER_DATABASE_CONNECTION_ERROR\n'));
  const rpc = giwaConfirmedTransport(httpStocksSignerRpc(config.rpcUrl));
  const result = status
    ? await signerJournalStatus({ pool, manifest: config.manifest, rpc })
    : await seedSignerJournal({ pool, manifest: config.manifest, reviewedInitialNonce: args[3], rpc });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  // Fixed error codes only (e.g. SIGNER_SEED_CHAIN_NONCE_MISMATCH); never URLs, rows or driver text.
  const raw = error && typeof error === 'object' ? (typeof error.code === 'string' ? error.code : error.message) : undefined;
  const code = typeof raw === 'string' && /^(SIGNER|STOCKS)_[A-Z_]+$/.test(raw) ? ` code=${raw}` : '';
  process.stderr.write(`SIGNER_JOURNAL_COMMAND_FAILED stage=${stage}${code}\n`);
  process.exitCode = 1;
} finally {
  try { await pool?.end(); } catch { /* fixed output above */ }
}

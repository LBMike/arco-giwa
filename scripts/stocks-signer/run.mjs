import pg from 'pg';
import { readStocksPublicJson } from '../../server/dist/stocks-runtime/public-config.js';
import { awsKmsSigningPort, createKmsCustody } from '../../server/dist/stocks-signer/custody-kms.js';
import { parseSignerHostConfig } from '../../server/dist/stocks-signer/host-config.js';
import { startStocksSignerHost } from '../../server/dist/stocks-signer/host.js';
import { httpStocksSignerRpc } from '../../server/dist/stocks-signer/http-rpc.js';

// Explicit public config only. No dotenv, private key, migrations or nonce seed.
const args = process.argv.slice(2);
let host, pool, custody, port;
let ownershipTransferred = false;
const abort = new AbortController();
let shutdown;
const stop = () => {
  abort.abort();
  if (host && !shutdown) shutdown = host.close().catch(() => {
    process.stderr.write('SIGNER_HOST_SHUTDOWN_FAILED\n'); process.exitCode = 1;
  });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  if (args.length !== 3 || args[0] !== '--config' || !['--check', '--serve'].includes(args[2]))
    throw Error('INVALID_ARGUMENTS');
  const config = parseSignerHostConfig(await readStocksPublicJson(args[1]));
  if (config.custody.type !== 'AWS_KMS') throw Error('KMS_CONFIGURATION_REQUIRED');
  const connectionString = process.env.STOCKS_SIGNER_DATABASE_URL;
  const bearerToken = process.env.STOCKS_SIGNER_TOKEN;
  if (!connectionString || connectionString.length > 4096 || !/^postgres(?:ql)?:\/\//.test(connectionString)
    || !bearerToken) throw Error('MISSING_SERVER_CONFIGURATION');
  port = awsKmsSigningPort({ ...config.custody, signerAddress: config.manifest.signerAddress });
  custody = createKmsCustody({ identity: { ...config.custody, signerAddress: config.manifest.signerAddress },
    fees: config.transaction, limits: config.limits, port });
  pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000, query_timeout: 6_000, idleTimeoutMillis: 10_000 });
  pool.on('error', () => process.stderr.write('SIGNER_DATABASE_CONNECTION_ERROR\n'));
  ownershipTransferred = true;
  host = await startStocksSignerHost({ config, pool, custody, bearerToken, signal: abort.signal,
    rpc: httpStocksSignerRpc(config.rpcUrl), mode: args[2] === '--check' ? 'check' : 'serve' });
  if (abort.signal.aborted) { stop(); await shutdown; }
  else process.stdout.write(host.address === null ? 'SIGNER_HOST_CHECK_PASSED\n' : 'SIGNER_HOST_LISTENING\n');
} catch {
  // No provider error, credential, DB URL, signed bytes or configuration echoed.
  process.stderr.write('SIGNER_HOST_START_FAILED: verify public config, dedicated database, token, IAM and reviewed account readiness.\n');
  process.exitCode = 1;
} finally {
  if (!ownershipTransferred) {
    try { await pool?.end(); }
    finally { if (custody) custody.close(); else port?.destroy(); }
  }
  if (!host?.address || abort.signal.aborted) {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import pg from 'pg';
import { readStocksPublicJson } from '../../server/dist/stocks-runtime/public-config.js';
import { createLocalKeystoreCustody } from '../../server/dist/stocks-signer/custody-local.js';
import { parseSignerHostConfig } from '../../server/dist/stocks-signer/host-config.js';
import { startStocksSignerHost } from '../../server/dist/stocks-signer/host.js';
import { httpStocksSignerRpc } from '../../server/dist/stocks-signer/http-rpc.js';
import { giwaConfirmedTransport } from '../../server/dist/stocks/giwa-confirmation.js';
import { readSecretPassword, withPrivateKeystoreCopy } from './secret-files.mjs';

// Hosted signer launcher (e.g. a Render private service). Non-interactive by design:
// the encrypted keystore and its password are two platform secret files. Never load
// dotenv, take a key or password from the environment, migrate/seed a DB or log input.
// Failures print one fixed line with the stage only.
const FORBIDDEN_ENV = ['DEPLOYER_PRIVATE_KEY', 'GIWA_KEYSTORE_PASSWORD', 'STOCKS_SIGNER_PRIVATE_KEY', 'STOCKS_SIGNER_KEYSTORE_PASSWORD'];
const args = process.argv.slice(2);
let host, pool, custody, stage = 'ARGUMENTS';
let ownershipTransferred = false;
const abort = new AbortController();
let shutdown;
const stop = () => {
  abort.abort();
  if (host && !shutdown) shutdown = host.close().catch(() => {
    process.stderr.write('SIGNER_SERVICE_SHUTDOWN_FAILED\n'); process.exitCode = 1;
  });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  if (args.length !== 7 || args[0] !== '--config' || args[2] !== '--keystore' || args[4] !== '--password-file'
    || ![args[1], args[3], args[5]].every(value => isAbsolute(value)) || !['--check', '--serve'].includes(args[6]))
    throw Error('INVALID_ARGUMENTS');
  stage = 'ENVIRONMENT';
  if (FORBIDDEN_ENV.some(name => process.env[name] !== undefined)) throw Error('SECRET_ENV_FORBIDDEN');
  const connectionString = process.env.STOCKS_SIGNER_DATABASE_URL;
  const bearerToken = process.env.STOCKS_SIGNER_TOKEN;
  if (!connectionString || connectionString.length > 4096 || !/^postgres(?:ql)?:\/\//.test(connectionString)
    || typeof bearerToken !== 'string' || !(/^[0-9a-f]{64}$/.test(bearerToken)
      || /^[A-Za-z0-9_-]{43}$/.test(bearerToken) && Buffer.from(bearerToken, 'base64url').length === 32
        && Buffer.from(bearerToken, 'base64url').toString('base64url') === bearerToken))
    throw Error('MISSING_SERVER_CONFIGURATION');
  stage = 'CONFIG';
  const config = parseSignerHostConfig(await readStocksPublicJson(args[1]));
  if (config.custody.type !== 'SECRET_FILE_KEYSTORE') throw Error('SECRET_FILE_CONFIGURATION_REQUIRED');
  stage = 'KEYSTORE';
  const requireContracts = createRequire(new URL('../../packages/contracts/package.json', import.meta.url));
  requireContracts('ts-node').register({ project: fileURLToPath(new URL('../../packages/contracts/tsconfig.json', import.meta.url)) });
  const { unlockLocalDeploymentWallet } = requireContracts('./scripts/stocks/local-keystore.ts');
  const wallet = await withPrivateKeystoreCopy(args[3], copy =>
    unlockLocalDeploymentWallet(copy, config.manifest.signerAddress, () => readSecretPassword(args[5])));
  custody = createLocalKeystoreCustody({ signerAddress: config.manifest.signerAddress,
    fees: config.transaction, limits: config.limits, signTransaction: wallet.signTransaction });
  if (abort.signal.aborted) throw Error('CANCELLED');
  stage = 'HOST_START';
  pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000, query_timeout: 6_000, idleTimeoutMillis: 10_000 });
  pool.on('error', () => process.stderr.write('SIGNER_DATABASE_CONNECTION_ERROR\n'));
  ownershipTransferred = true;
  host = await startStocksSignerHost({ config, pool, custody, bearerToken, signal: abort.signal,
    rpc: giwaConfirmedTransport(httpStocksSignerRpc(config.rpcUrl)), mode: args[6] === '--check' ? 'check' : 'serve' });
  if (abort.signal.aborted) { stop(); await shutdown; }
  else process.stdout.write(host.address === null ? 'SIGNER_SERVICE_CHECK_PASSED\n' : 'SIGNER_SERVICE_LISTENING\n');
} catch {
  process.stderr.write(`SIGNER_SERVICE_START_FAILED stage=${stage}\n`);
  process.exitCode = 1;
} finally {
  if (!ownershipTransferred) {
    try { await pool?.end(); }
    finally { custody?.close(); }
  }
  if (!host?.address || abort.signal.aborted) {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

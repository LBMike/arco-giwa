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

// Operator-local CLI. Never load dotenv, export a key, migrate/seed a DB or log input.
const args = process.argv.slice(2);
let host, pool, custody;
let ownershipTransferred = false;
const abort = new AbortController();
let shutdown;
let cancelPrompt;
const stop = () => {
  abort.abort();
  // The reviewed hidden prompt already owns Ctrl+C cleanup (raw mode/listener).
  // Deliver that cancellation only while this CLI owns the active prompt.
  cancelPrompt?.();
  if (host && !shutdown) shutdown = host.close().catch(() => {
    process.stderr.write('SIGNER_LOCAL_HOST_SHUTDOWN_FAILED\n'); process.exitCode = 1;
  });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  if (args.length !== 5 || args[0] !== '--config' || args[2] !== '--keystore'
    || !isAbsolute(args[1]) || !isAbsolute(args[3]) || !['--check', '--serve'].includes(args[4]))
    throw Error('INVALID_ARGUMENTS');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('LOCAL_TTY_REQUIRED');
  if (['DEPLOYER_PRIVATE_KEY', 'GIWA_KEYSTORE_PASSWORD', 'STOCKS_SIGNER_PRIVATE_KEY', 'STOCKS_SIGNER_KEYSTORE_PASSWORD']
    .some(name => process.env[name] !== undefined)) throw Error('SECRET_ENV_FORBIDDEN');
  const config = parseSignerHostConfig(await readStocksPublicJson(args[1]));
  if (config.custody.type !== 'LOCAL_KEYSTORE') throw Error('LOCAL_CONFIGURATION_REQUIRED');
  const connectionString = process.env.STOCKS_SIGNER_DATABASE_URL;
  const bearerToken = process.env.STOCKS_SIGNER_TOKEN;
  if (!connectionString || connectionString.length > 4096 || !/^postgres(?:ql)?:\/\//.test(connectionString)
    || typeof bearerToken !== 'string' || !(/^[0-9a-f]{64}$/.test(bearerToken)
      || /^[A-Za-z0-9_-]{43}$/.test(bearerToken) && Buffer.from(bearerToken, 'base64url').length === 32
        && Buffer.from(bearerToken, 'base64url').toString('base64url') === bearerToken))
    throw Error('MISSING_SERVER_CONFIGURATION');
  const requireContracts = createRequire(new URL('../../packages/contracts/package.json', import.meta.url));
  requireContracts('ts-node').register({ project: fileURLToPath(new URL('../../packages/contracts/tsconfig.json', import.meta.url)) });
  const { unlockLocalDeploymentWallet } = requireContracts('./scripts/stocks/local-keystore.ts');
  const { promptHidden } = requireContracts('./scripts/hidden-prompt.ts');
  const wallet = await unlockLocalDeploymentWallet(args[3], config.manifest.signerAddress, async () => {
    if (abort.signal.aborted) throw Error('CANCELLED');
    try {
      const pending = promptHidden('GIWA operator keystore password: ');
      cancelPrompt = () => process.stdin.emit('data', Buffer.from([3]));
      return await pending;
    } finally { cancelPrompt = undefined; process.stdin.pause(); }
  });
  custody = createLocalKeystoreCustody({ signerAddress: config.manifest.signerAddress,
    fees: config.transaction, limits: config.limits, signTransaction: wallet.signTransaction });
  if (abort.signal.aborted) throw Error('CANCELLED');
  pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000, query_timeout: 6_000, idleTimeoutMillis: 10_000 });
  pool.on('error', () => process.stderr.write('SIGNER_DATABASE_CONNECTION_ERROR\n'));
  ownershipTransferred = true;
  host = await startStocksSignerHost({ config, pool, custody, bearerToken, signal: abort.signal,
    rpc: giwaConfirmedTransport(httpStocksSignerRpc(config.rpcUrl)), mode: args[4] === '--check' ? 'check' : 'serve' });
  if (abort.signal.aborted) { stop(); await shutdown; }
  else process.stdout.write(host.address === null ? 'SIGNER_LOCAL_HOST_CHECK_PASSED\n' : 'SIGNER_LOCAL_HOST_LISTENING\n');
} catch {
  process.stderr.write('SIGNER_LOCAL_HOST_START_FAILED: use a local terminal and verify reviewed config, encrypted wallet, dedicated database and token.\n');
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

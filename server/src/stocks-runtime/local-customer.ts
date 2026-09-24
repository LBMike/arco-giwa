import { ensure, manifestDigest, type Manifest } from '../stocks/contracts.js';

export const LOCAL_CUSTOMER_ORIGIN = 'http://127.0.0.1:4392';
export const LOCAL_CUSTOMER_API = 'http://127.0.0.1:4393';
export const LOCAL_CUSTOMER_SIGNER = 'http://127.0.0.1:4394';
export const LOCAL_CUSTOMER_RPC = 'https://sepolia-rpc.giwa.io';
export const LOCAL_CUSTOMER_MANIFEST = '4327e1459e77c9a15b4b2b3e6d156a30ddd73b16dd4b45836969c23128390247';
export const LOCAL_CUSTOMER_ADMIN = '0xfdcf58e2954988e5bf0446aaf1284a1069136f29';
const project = 'munsybkrsxrmajmbssli';
const fail = () => Error('LOCAL_CUSTOMER_CONFIGURATION_INVALID');

/** Dedicated local composition only; never selected by browser input or normal server env. */
export function validateLocalCustomerRuntime(row: {
  manifest: Manifest; rpcUrl: string; signerUrl: string; operatorControls?: boolean;
  operators: ReadonlyArray<{ wallet: string; operatorId: string; permissions: readonly string[] }>;
}) {
  ensure(row.rpcUrl === LOCAL_CUSTOMER_RPC && row.signerUrl === LOCAL_CUSTOMER_SIGNER
    && manifestDigest(row.manifest) === LOCAL_CUSTOMER_MANIFEST
    && row.manifest.signerAddress === LOCAL_CUSTOMER_ADMIN
    && row.operatorControls === true
    && row.operators.length === 1 && row.operators[0].wallet === LOCAL_CUSTOMER_ADMIN
    && row.operators[0].permissions.includes('stocks:read')
    && row.operators[0].permissions.includes('stocks:control'), 'LOCAL_CUSTOMER_CONFIGURATION_INVALID');
}

export function validateLocalCustomerEnvironment(env: NodeJS.ProcessEnv) {
  try {
    for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
      const value = env[name];
      if (!value) throw fail();
      const url = new URL(value);
      const direct = url.hostname === `db.${project}.supabase.co` && decodeURIComponent(url.username) === 'postgres';
      const pooled = url.hostname === 'aws-1-ap-southeast-2.pooler.supabase.com'
        && decodeURIComponent(url.username) === `postgres.${project}`;
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !(direct || pooled)
        || !url.password || url.pathname !== '/postgres' || url.port !== '5432' || url.hash) throw fail();
      // pg-connection-string query parameters can override hostname/user/port
      // and read local TLS key files. Only an explicit TLS mode is accepted.
      if ([...url.searchParams.keys()].some(key => key !== 'sslmode') || url.searchParams.getAll('sslmode').length > 1
        || url.searchParams.has('sslmode') && !['require', 'verify-full'].includes(url.searchParams.get('sslmode')!)) throw fail();
    }
    if (env.STOCKS_DATABASE_URL && env.STOCKS_DATABASE_URL !== env.DATABASE_URL) throw fail();
    if (env.PORT !== '4393' || env.CORS_ALLOWED_ORIGINS !== LOCAL_CUSTOMER_ORIGIN
      || env.INDEXER_RPC_URL !== LOCAL_CUSTOMER_RPC || env.STOCKS_MODE !== 'DEMO_TESTNET'
      || env.STOCKS_AUTODISPATCH !== '1' || !env.STOCKS_CONFIG_PATH || !env.STOCKS_SIGNER_TOKEN) throw fail();
    for (const name of ['DEPLOYER_PRIVATE_KEY', 'GIWA_KEYSTORE_PASSWORD', 'STOCKS_SIGNER_PRIVATE_KEY', 'STOCKS_SIGNER_KEYSTORE_PASSWORD']) {
      if (env[name] !== undefined) throw fail();
    }
  } catch { throw fail(); }
}

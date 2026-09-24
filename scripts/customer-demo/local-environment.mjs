import { open, constants } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateLocalCustomerEnvironment } from '../../server/dist/stocks-runtime/local-customer.js';

const fields = ['DATABASE_URL', 'DIRECT_URL', 'AUTH_JWT_SECRET', 'ADMIN_OPERATOR_TOKEN', 'STOCKS_SIGNER_TOKEN'];
const fail = () => Error('LOCAL_CUSTOMER_SERVER_CONFIGURATION_UNAVAILABLE');

export function createLocalCustomerServerConfig(databaseUrl) {
  const value = { DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl,
    AUTH_JWT_SECRET: randomBytes(32).toString('hex'), ADMIN_OPERATOR_TOKEN: randomBytes(32).toString('hex'), STOCKS_SIGNER_TOKEN: randomBytes(32).toString('hex') };
  localCustomerEnvironment(value, '/public/runtime.json', {});
  return value;
}

export function localCustomerEnvironment(value, runtimePath, inherited = process.env) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...fields].sort().join(',') || !isAbsolute(runtimePath)) throw fail();
    for (const name of fields) if (typeof value[name] !== 'string' || !value[name] || value[name].length > 4096) throw fail();
    for (const name of ['AUTH_JWT_SECRET', 'ADMIN_OPERATOR_TOKEN', 'STOCKS_SIGNER_TOKEN']) {
      if (!/^[0-9a-f]{64}$/.test(value[name])) throw fail();
    }
    const env = {
      ...(inherited.PATH ? { PATH: inherited.PATH } : {}),
      ...(inherited.HOME ? { HOME: inherited.HOME } : {}),
      ...(inherited.TMPDIR ? { TMPDIR: inherited.TMPDIR } : {}),
      ...value, PORT: '4493', CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:4392',
      INDEXER_RPC_URL: 'https://sepolia-rpc.giwa.io', STOCKS_MODE: 'DEMO_TESTNET', STOCKS_AUTODISPATCH: '1',
      STOCKS_CONFIG_PATH: runtimePath,
    };
    validateLocalCustomerEnvironment(env);
    return env;
  } catch { throw fail(); }
}

/** Explicit private input only; never discover dotenv files or expose input in errors. */
export async function readLocalCustomerServerConfig(path) {
  let file;
  try {
    if (!isAbsolute(path)) throw fail();
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16384 || stat.size === 0 || stat.nlink !== 1
      || stat.mode & 0o077 || stat.uid !== process.getuid?.()) throw fail();
    const buffer = Buffer.alloc(16385);
    let length = 0;
    for (;;) {
      const read = await file.read(buffer, length, buffer.length - length, null);
      length += read.bytesRead;
      if (length > 16384) throw fail();
      if (read.bytesRead === 0) break;
    }
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } catch { throw fail(); }
  finally { await file?.close(); }
}

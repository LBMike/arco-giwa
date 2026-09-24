import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localCustomerEnvironment, readLocalCustomerServerConfig } from './local-environment.mjs';
import { readStocksPublicJson } from '../../server/dist/stocks-runtime/public-config.js';
import { parseStocksRuntimeConfig } from '../../server/dist/stocks-runtime/runtime.js';

try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--server-config' || args[2] !== '--runtime-config') throw Error('ARGS');
  // Validate all public input before loading the explicit private server configuration.
  parseStocksRuntimeConfig(await readStocksPublicJson(args[3]), true);
  const env = localCustomerEnvironment(await readLocalCustomerServerConfig(args[1]), args[3]);
  const source = "import { startServer } from './server/dist/index.js'; startServer(process.env, true, true).then(() => console.log('LOCAL_CUSTOMER_API_LISTENING')).catch(() => { console.error('LOCAL_CUSTOMER_API_START_FAILED'); process.exitCode = 1; });";
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), env, stdio: 'inherit',
  });
  const stop = signal => child.kill(signal);
  const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  }).finally(() => {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  });
  process.exitCode = code;
} catch {
  console.error('LOCAL_CUSTOMER_API_START_FAILED'); process.exitCode = 1;
}

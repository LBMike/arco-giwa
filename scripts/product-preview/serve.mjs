import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { publicReadGateway, publicUpstream } from './gateway.mjs';

const { values } = parseArgs({ options: { port: { type: 'string', default: '5173' }, 'dynamic-environment': { type: 'string' }, 'legacy-api': { type: 'string', default: 'https://arco-giwa-api.onrender.com' }, 'market-api': { type: 'string', default: 'http://127.0.0.1:4392' } } });
const port = Number(values.port), environmentId = values['dynamic-environment'];
if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(environmentId ?? '')) throw new Error('Valid --port and --dynamic-environment UUID required');
const legacy = publicUpstream(values['legacy-api']), market = publicUpstream(values['market-api'], true);
const origin = `http://127.0.0.1:${port}`;
if (market === origin || legacy === origin) throw new Error('UPSTREAM_MUST_DIFFER');
const root = fileURLToPath(new URL('../../', import.meta.url));
const isolated = await mkdtemp(join(tmpdir(), 'arco-product-preview-'));
const server = await createServer({
  root, configFile: false, envDir: isolated, envPrefix: 'ARCO_PRODUCT_PREVIEW_UNUSED_', cacheDir: join(isolated, 'cache'),
  plugins: [react(), { name: 'public-product-read-gateway', configureServer(vite) { vite.middlewares.use(publicReadGateway({ origin, legacy, market })); } }],
  resolve: { alias: { '@': resolve(root, 'src') } },
  define: {
    'import.meta.env.VITE_DYNAMIC_ENVIRONMENT_ID': JSON.stringify(environmentId),
    'import.meta.env.VITE_ARCO_API_BASE': JSON.stringify(origin),
    'import.meta.env.VITE_CUSTOMER_PRESENTATION': JSON.stringify('true'),
    'import.meta.env.VITE_STOCKS_DEMO_MARKET': JSON.stringify('false'),
    'import.meta.env.VITE_PUBLIC_GIWA_RPC': JSON.stringify('https://sepolia-rpc.giwa.io'),
  },
  server: { host: '127.0.0.1', port, strictPort: true, fs: { deny: ['**/.env*', '**/.secrets/**', '**/.git/**', '**/*.{crt,pem}'] } },
});
await server.listen();
console.log(`Product preview: ${origin} (public Savings/Funds, Stocks market via ${market}, Dynamic wallet; Stocks transaction backend not connected)`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); process.exit(0); });

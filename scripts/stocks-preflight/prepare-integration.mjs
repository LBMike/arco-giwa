import { realpath, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

function publicPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.split(/[\\/]/).some(p => p.toLowerCase().startsWith('.env') || p.toLowerCase() === '.secrets')) throw new Error('PUBLIC_PATH_REQUIRED');
  return value;
}

const args = process.argv.slice(2);
try {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: npm run stocks:integration:prepare -- --manifest /absolute/manifest.json --settings /absolute/public-settings.json --output /absolute/new-directory\nOffline only. Requires a separately retained manifest digest and explicit public settings. Creates paused runtime-config.json and integration.json; never overwrites. No dotenv, deployment, signing or network calls.');
  } else {
    if (args.length !== 6 || args[0] !== '--manifest' || args[2] !== '--settings' || args[4] !== '--output') throw new Error('INVALID_ARGUMENTS');
    const output = resolve(publicPath(args[5]));
    publicPath(output);
    // Check resolved parents too, before writing through any directory link.
    publicPath(await realpath(resolve(output, '..')));
    const { readStocksPublicJson } = await import('../../server/dist/stocks-runtime/public-config.js');
    const manifest = await readStocksPublicJson(publicPath(args[1])), settings = await readStocksPublicJson(publicPath(args[3]));
    const { prepareStocksIntegrationBundle } = await import('../../server/dist/stocks-preflight/integration-bundle.js');
    const bundle = prepareStocksIntegrationBundle(manifest, settings);
    await mkdir(output, { mode: 0o700 });
    await writeFile(resolve(output, 'runtime-config.json'), bundle.runtimeText, { flag: 'wx', mode: 0o600 });
    // Written last: absence means the bundle is incomplete. Partial files are
    // retained after I/O failure for inspection; never delete caller data.
    await writeFile(resolve(output, 'integration.json'), JSON.stringify(bundle.integration, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ status: 'PREPARED_NOT_PROBED', tradingAuthorized: false }));
  }
} catch {
  console.log(JSON.stringify({ status: 'BLOCKED', tradingAuthorized: false, error: 'INTEGRATION_BUNDLE_NOT_CREATED' }));
  process.exitCode = 1;
}

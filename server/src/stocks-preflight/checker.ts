import { immutable, manifestDigest, PROFILE } from '../stocks/contracts.js';
import { parseStocksRuntimeConfig, stocksAutodispatch, type StocksRuntimeConfig } from '../stocks-runtime/runtime.js';
import { createDeploymentEvidence } from '../stocks-execution/deployment.js';

export type Check = { id: string; status: 'PASS' | 'FAIL' | 'NOT_CHECKED'; code: string };
export type Prepared = { config: StocksRuntimeConfig; databaseUrl: string; historySchema: 'public' | 'arco_evm'; signerToken: string };
export type Report = typeof PROFILE & {
    observedAt: string; mode: 'OFFLINE' | 'ONLINE';
    status: 'DISABLED' | 'BLOCKED' | 'CONFIGURED_NOT_PROBED' | 'STARTUP_CHECKS_PASSED';
    tradingAuthorized: false; checks: Check[];
};
type Probes = { database: () => Promise<Check[]>; deployment: () => Promise<void>; signer: () => Promise<void> };
const result = (id: string, ok: boolean, code: string): Check => ({ id, status: ok ? 'PASS' : 'FAIL', code });

// No runtime creation, environment discovery, workers or mutations. Ports are
// constructed only after all configuration checks pass and online is explicit.
export async function checkStocksPreflight(env: NodeJS.ProcessEnv, options: {
    online?: boolean;
    readConfig: (path: string) => Promise<unknown>;
    probes: (prepared: Prepared) => Probes;
}): Promise<Report> {
    env = { ...env };
    const online = options.online === true, checks: Check[] = [];
    const report = (status: Report['status']): Report => immutable({ ...PROFILE, observedAt: new Date().toISOString(), mode: online ? 'ONLINE' : 'OFFLINE', status, tradingAuthorized: false, checks });
    let autodispatch = false;
    try { autodispatch = stocksAutodispatch(env); checks.push(result('mode', true, 'MODE_VALID')); }
    catch { checks.push(result('mode', false, 'INVALID_MODE_OR_AUTODISPATCH')); return report('BLOCKED'); }
    if (env.STOCKS_MODE !== 'DEMO_TESTNET') return report('DISABLED');

    let config: StocksRuntimeConfig | undefined;
    if (!env.STOCKS_CONFIG_PATH) checks.push(result('configuration', false, 'CONFIG_PATH_REQUIRED'));
    else {
        try {
            config = parseStocksRuntimeConfig(await options.readConfig(env.STOCKS_CONFIG_PATH));
            // Also validate the public manifest whitelist without making RPC calls.
            createDeploymentEvidence(config.manifest, async () => { throw new Error('OFFLINE'); });
            if (new URL(config.signerUrl).pathname !== '/') throw new Error('SIGNER_ROOT_REQUIRED');
            checks.push(result('configuration', true, 'CONFIG_VALID'));
        } catch { config = undefined; checks.push(result('configuration', false, 'CONFIG_INVALID_OR_UNREADABLE')); }
    }
    const signerToken = env.STOCKS_SIGNER_TOKEN ?? '';
    checks.push(result('signerCredential', !!signerToken.trim(), signerToken.trim() ? 'CREDENTIAL_PRESENT' : 'SIGNER_TOKEN_REQUIRED'));
    const databaseUrl = env.STOCKS_DATABASE_URL ?? env.DATABASE_URL ?? '';
    let historySchema: Prepared['historySchema'] = 'public', dbValid = false;
    try {
        const url = new URL(databaseUrl);
        const schema = url.searchParams.get('schema') ?? 'public';
        dbValid = ['postgres:', 'postgresql:'].includes(url.protocol) && !!url.hostname && url.pathname.length > 1 && ['public', 'arco_evm'].includes(schema);
        if (dbValid) historySchema = schema as Prepared['historySchema'];
    } catch { /* report only a fixed code, never the supplied URL */ }
    checks.push(result('databaseConfiguration', dbValid, dbValid ? 'DATABASE_CONFIGURED' : 'DATABASE_URL_INVALID_OR_MISSING'));
    checks.push(result('autodispatch', autodispatch, autodispatch ? 'OBSERVATION_ENABLED_ON_START' : 'AUTODISPATCH_REQUIRED_FOR_OBSERVATION'));
    if (config) {
        checks.push(result('startupPause', config.paused, config.paused ? 'PAUSED_START_CONFIGURED' : 'PAUSED_START_REQUIRED'));
        // The runtime parser validates identities and permissions. A deployment
        // additionally requires a reader so its state can be inspected.
        const validOperators = config.operators.some(op => op.permissions.includes('stocks:read'));
        checks.push(result('operators', validOperators, validOperators ? 'NAMED_READER_CONFIGURED' : 'NAMED_READER_INVALID_OR_MISSING'));
    }
    for (const id of ['database', 'deployment', 'signer']) checks.push({ id, status: 'NOT_CHECKED', code: online ? 'CONFIGURATION_BLOCKED' : 'ONLINE_CHECK_REQUIRED' });
    if (checks.some(c => c.status === 'FAIL') || !config) return report('BLOCKED');
    if (!online) return report('CONFIGURED_NOT_PROBED');
    let probes: Probes;
    try { probes = options.probes({ config: immutable(config), databaseUrl, historySchema, signerToken }); }
    catch { checks.push(result('probeSetup', false, 'PROBE_SETUP_FAILED')); return report('BLOCKED'); }
    // Checks are independent read-only requests. Each adapter owns a bounded
    // timeout and resource cleanup; no signing or startup port is provided.
    const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => probes.database()),
        Promise.resolve().then(() => probes.deployment()),
        Promise.resolve().then(() => probes.signer()),
    ]);
    for (let i = 0; i < outcomes.length; i++) {
        const id = ['database', 'deployment', 'signer'][i], outcome = outcomes[i];
        const at = checks.findIndex(c => c.id === id);
        checks[at] = result(id, outcome.status === 'fulfilled', outcome.status === 'fulfilled' ? `${id.toUpperCase()}_VERIFIED` : `${id.toUpperCase()}_UNAVAILABLE_OR_INVALID`);
        if (i === 0 && outcome.status === 'fulfilled') checks.push(...outcome.value as Check[]);
    }
    // This snapshot permits only a reviewed paused startup, never a trade.
    return report(checks.some(c => c.status === 'FAIL') ? 'BLOCKED' : 'STARTUP_CHECKS_PASSED');
}

export function preflightDigest(config: StocksRuntimeConfig): string { return manifestDigest(config.manifest); }

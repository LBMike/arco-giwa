import { createHash } from 'node:crypto';
import { address, ensure, immutable, manifestDigest, type Manifest } from '../stocks/contracts.js';
import { createDeploymentEvidence } from '../stocks-execution/deployment.js';
import { parseStocksRuntimeConfig } from '../stocks-runtime/runtime.js';
import { validTradingControlText } from '../stocks-trading-control/validation.js';

function object(value: unknown, keys: string[]): Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_BUNDLE_INPUT');
  ensure(Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'UNEXPECTED_BUNDLE_FIELDS');
  return value as Record<string, unknown>;
}

function url(value: unknown, originOnly: boolean, localDemoFrontend = false): string {
  // Only the user's fixed local frontend is exempt. Never relax server endpoints.
  if (localDemoFrontend && originOnly && value === 'http://127.0.0.1:4392') return value;
  ensure(typeof value === 'string' && value.startsWith('https://') && !/[\s\\?#]/.test(value), 'INVALID_BUNDLE_URL');
  const parsed = new URL(value);
  // A comma in a parsed hostname would split CORS_ALLOWED_ORIGINS into
  // different origins; percent-encoded commas must be rejected after parsing.
  ensure(!parsed.username && !parsed.password && parsed.hostname && !/[,*]/.test(parsed.hostname) && (!originOnly || parsed.pathname === '/'), 'INVALID_BUNDLE_URL');
  return originOnly ? parsed.origin : parsed.href;
}

/** Offline configuration assembly, not chain evidence or permission to trade. */
export function prepareStocksIntegrationBundle(manifestValue: unknown, settingsValue: unknown) {
  const settings = object(settingsValue, ['expectedManifestDigest', 'contractPolicyVerified', 'rpcUrl', 'publicRpcUrl', 'signerUrl', 'apiBaseUrl', 'frontendOrigins', 'operators']);
  ensure(settings.contractPolicyVerified === true, 'CONTRACT_POLICY_REVIEW_REQUIRED');
  const manifest = manifestValue as Manifest;
  // Reuse the public-manifest whitelist and current ABI validation. get() is
  // deliberately never called: this command has no RPC or signer transport.
  createDeploymentEvidence(manifest, async () => { throw new Error('OFFLINE_BUNDLE_ONLY'); });
  const digest = manifestDigest(manifest);
  ensure(typeof settings.expectedManifestDigest === 'string' && /^[0-9a-f]{64}$/.test(settings.expectedManifestDigest) && settings.expectedManifestDigest === digest, 'BUNDLE_MANIFEST_DIGEST_MISMATCH');
  const rpcUrl = url(settings.rpcUrl, false), publicRpcUrl = url(settings.publicRpcUrl, false);
  const signerUrl = url(settings.signerUrl, true), apiBaseUrl = url(settings.apiBaseUrl, true);
  ensure(Array.isArray(settings.frontendOrigins) && settings.frontendOrigins.length > 0 && settings.frontendOrigins.length <= 10, 'INVALID_FRONTEND_ORIGINS');
  const origins = settings.frontendOrigins.map(value => url(value, true, true));
  ensure(new Set(origins).size === origins.length, 'DUPLICATE_FRONTEND_ORIGIN');
  ensure(Array.isArray(settings.operators) && settings.operators.length > 0 && settings.operators.length <= 100, 'INVALID_BUNDLE_OPERATORS');
  const operators = settings.operators.map(value => {
    const op = object(value, ['wallet', 'operatorId', 'permissions']);
    ensure(typeof op.wallet === 'string' && validTradingControlText(op.operatorId, 128), 'INVALID_BUNDLE_OPERATOR');
    ensure(Array.isArray(op.permissions) && op.permissions.includes('stocks:read') && op.permissions.every(p => p === 'stocks:read' || p === 'stocks:control') && new Set(op.permissions).size === op.permissions.length, 'INVALID_BUNDLE_PERMISSIONS');
    return { wallet: address(op.wallet), operatorId: op.operatorId as string, permissions: [...op.permissions] as string[] };
  });
  ensure(new Set(operators.map(op => op.wallet)).size === operators.length && new Set(operators.map(op => op.operatorId)).size === operators.length, 'DUPLICATE_BUNDLE_OPERATOR');
  ensure(operators.some(op => op.permissions.includes('stocks:control')), 'CONTROL_OPERATOR_REQUIRED');
  const runtime = parseStocksRuntimeConfig({ profile: 'DEMO_TESTNET', manifest, rpcUrl, signerUrl,
    contractPolicyVerified: true, paused: true, operatorControls: true, operators });
  const runtimeText = JSON.stringify(runtime, null, 2) + '\n';
  ensure(Buffer.byteLength(runtimeText, 'utf8') <= 65536, 'BUNDLE_RUNTIME_CONFIG_TOO_LARGE');
  const integration = {
    schemaVersion: 1, status: 'PREPARED_NOT_PROBED', tradingAuthorized: false,
    manifestDigest: digest, runtimeConfigFile: 'runtime-config.json',
    runtimeConfigSha256: createHash('sha256').update(runtimeText).digest('hex'),
    serverEnvironment: { STOCKS_MODE: 'DEMO_TESTNET', STOCKS_AUTODISPATCH: '1', CORS_ALLOWED_ORIGINS: origins.join(',') },
    // Browser RPC is separately supplied; the server RPC/signing endpoint must
    // never be copied into a browser build by inference.
    browserEnvironment: { VITE_ARCO_API_BASE: apiBaseUrl, VITE_PUBLIC_GIWA_RPC: publicRpcUrl, VITE_CUSTOMER_PRESENTATION: 'true',
      VITE_GIWA_ADMIN_ADDRESSES: operators.map(op => op.wallet).join(',') },
    frontendOrigins: origins, siweDomains: origins.map(origin => new URL(origin).host),
    requiredServerOnlyNames: ['DATABASE_URL', 'DIRECT_URL', 'INDEXER_RPC_URL', 'AUTH_JWT_SECRET', 'ADMIN_OPERATOR_TOKEN', 'STOCKS_SIGNER_TOKEN', 'STOCKS_CONFIG_PATH'],
    nextSteps: ['READ_ONLY_ONLINE_PREFLIGHT', 'PAUSED_START_AND_CURRENT_OBSERVATION', 'VERIFY_BALANCE_RECONCILIATION', 'REVIEW_CONFIGURED_PAUSE_BEFORE_OPERATOR_RESUME'],
  };
  return immutable({ runtimeText, integration });
}

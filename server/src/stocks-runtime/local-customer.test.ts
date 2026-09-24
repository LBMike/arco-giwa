import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStocksRuntimeConfig } from './runtime.js';
import { validateLocalCustomerEnvironment, LOCAL_CUSTOMER_ADMIN, LOCAL_CUSTOMER_RPC, LOCAL_CUSTOMER_SIGNER } from './local-customer.js';

const config = () => ({ profile: 'DEMO_TESTNET',
  manifest: JSON.parse(readFileSync('docs/evidence/giwa-public-deploy-007/verified-manifest.json', 'utf8')),
  rpcUrl: LOCAL_CUSTOMER_RPC, signerUrl: LOCAL_CUSTOMER_SIGNER, contractPolicyVerified: true, paused: true, operatorControls: true,
  operators: [{ wallet: LOCAL_CUSTOMER_ADMIN, operatorId: 'local-demo-admin', permissions: ['stocks:read', 'stocks:control'] }],
});
test('only dedicated local composition accepts the exact deployed manifest and loopback signer', () => {
  const row = config();
  assert.equal(parseStocksRuntimeConfig(row, true).signerUrl, LOCAL_CUSTOMER_SIGNER);
  assert.throws(() => parseStocksRuntimeConfig(row), /INVALID_STOCKS_ENDPOINT/);
  for (const patch of [
    { signerUrl: LOCAL_CUSTOMER_SIGNER + '/' }, { signerUrl: 'http://localhost:4394' },
    { signerUrl: 'http://127.1:4394' }, { signerUrl: 'http://127.0.0.1:4395' },
    { signerUrl: 'https://signer.example.test' }, { rpcUrl: 'https://elsewhere.example' },
    { operators: [] }, { manifest: { ...row.manifest, deploymentId: 'changed' } },
    { operatorControls: false }, { operatorControls: undefined },
    { operators: [{ ...row.operators[0], permissions: ['stocks:control'] }] },
  ]) assert.throws(() => parseStocksRuntimeConfig({ ...row, ...patch }, true));
});
test('local server rejects split databases, wrong origins and hidden key overrides before any connection', () => {
  const env = {
    DATABASE_URL: 'postgresql://postgres.munsybkrsxrmajmbssli:TEST@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres',
    DIRECT_URL: 'postgresql://postgres:TEST@db.munsybkrsxrmajmbssli.supabase.co:5432/postgres',
    PORT: '4493', CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:4392', INDEXER_RPC_URL: LOCAL_CUSTOMER_RPC,
    STOCKS_MODE: 'DEMO_TESTNET', STOCKS_AUTODISPATCH: '1', STOCKS_CONFIG_PATH: '/config.json', STOCKS_SIGNER_TOKEN: 'TEST',
  };
  assert.doesNotThrow(() => validateLocalCustomerEnvironment(env));
  for (const patch of [{ PORT: '8080' }, { CORS_ALLOWED_ORIGINS: '*' }, { STOCKS_DATABASE_URL: 'another' },
    { GIWA_KEYSTORE_PASSWORD: 'NEVER_PRINT' }, { DIRECT_URL: env.DIRECT_URL.replace('munsybkrsxrmajmbssli', 'other') }]) {
    assert.throws(() => validateLocalCustomerEnvironment({ ...env, ...patch }), { message: 'LOCAL_CUSTOMER_CONFIGURATION_INVALID' });
  }
  for (const query of ['?host=foreign.example', '?user=other', '?port=5433', '?host=/tmp', '?sslkey=/private/key',
    '?sslmode=disable', '?sslmode=require&sslmode=disable']) {
    assert.throws(() => validateLocalCustomerEnvironment({ ...env, DATABASE_URL: env.DATABASE_URL + query }));
  }
  assert.doesNotThrow(() => validateLocalCustomerEnvironment({ ...env, DATABASE_URL: env.DATABASE_URL + '?sslmode=verify-full' }));
});

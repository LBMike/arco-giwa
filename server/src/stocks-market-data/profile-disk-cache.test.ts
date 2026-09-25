import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStocksMarketDataService } from './service.js';
import type { DisplayCatalog } from './contracts.js';

const NOW = Date.parse('2026-09-25T17:00:00.000Z');
const catalog = (symbol: string): DisplayCatalog => ({ securities: [{ symbol, name: symbol }], provenance: { sourceUrl: null, rankingMetric: null, period: null, asOfDate: null, verification: 'CURATED' } });
const profile = (symbol: string, type = 'CS') => JSON.stringify({ status: 'OK', results: { ticker: symbol, locale: 'us', market: 'stocks', currency_name: 'usd', name: symbol, type, market_cap: 123456789, share_class_shares_outstanding: 42000000, branding: { icon_url: 'https://api.massive.com/v1/reference/company-branding/abc/images/icon.png' } } });
const aum = (symbol: string) => JSON.stringify({ status: 'OK', results: [{ composite_ticker: symbol, product_type: 'etf', aum: 987654321.125, effective_date: '2026-09-24' }] });
const response = (body: string) => new Response(body, { headers: { 'Content-Type': 'application/json' } });

test('validated public profiles persist across server recreation without provider calls', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'giwa-profile-cache-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'profile.json'); let calls = 0;
  const first = createStocksMarketDataService({ apiKey: 'DO_NOT_PERSIST_SECRET', profileCachePath: path, catalog: catalog('NVDA'), now: () => NOW, fetch: async () => { calls++; return response(profile('NVDA')); } });
  assert.equal((await first.profile('NVDA')).data?.marketCap, '123456789');
  assert.equal(calls, 1);
  const bytes = readFileSync(path, 'utf8');
  assert.equal(statSync(path).mode & 0o077, 0, 'cache is owner-readable only');
  assert.ok(!bytes.includes('DO_NOT_PERSIST_SECRET'));
  assert.ok(!bytes.includes('apiKey'));
  const restored = createStocksMarketDataService({ apiKey: 'DO_NOT_PERSIST_SECRET', profileCachePath: path, catalog: catalog('NVDA'), now: () => NOW + 1000, fetch: async () => { calls++; throw new Error('should not refresh'); } });
  const loaded = await restored.profile('NVDA');
  assert.equal(loaded.status, 'AVAILABLE');
  assert.equal(loaded.data?.marketCap, '123456789');
  assert.equal(loaded.data?.logoUrl, '/api/v1/stocks/market/NVDA/logo');
  assert.equal(calls, 1);
});

test('ETF AUM survives restart and free-tier budget exhaustion preserves its previous value', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'giwa-profile-cache-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'profile.json'); let now = NOW, calls = 0;
  const fetcher: typeof fetch = async input => { calls++; return response(String(input).includes('/etf-global/') ? aum('SOXL') : profile('SOXL', 'ETF')); };
  const first = createStocksMarketDataService({ apiKey: 'fixture', profileCachePath: path, catalog: catalog('SOXL'), now: () => now, fetch: fetcher });
  assert.equal((await first.profile('SOXL')).data?.aum, '987654321.125');
  assert.equal(calls, 2);
  const restored = createStocksMarketDataService({ apiKey: 'fixture', profileCachePath: path, catalog: catalog('SOXL'), now: () => now, fetch: async () => { calls++; throw new Error('should not refresh'); } });
  assert.equal((await restored.profile('SOXL')).data?.aum, '987654321.125');
  assert.equal(calls, 2);
  now += 86400001;
  const limited = createStocksMarketDataService({ apiKey: 'fixture', profileCachePath: path, catalog: catalog('SOXL'), now: () => now, massiveRequestsPerMinute: 1, fetch: fetcher });
  const staleAum = await limited.profile('SOXL');
  assert.equal(staleAum.reason, 'REQUEST_BUDGET_EXHAUSTED');
  assert.equal(staleAum.data?.aum, '987654321.125');
  assert.equal(calls, 3, 'one free-tier call; no second provider request');
});

test('invalid, cross-symbol and expired disk entries are ignored', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'giwa-profile-cache-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'profile.json'); let calls = 0;
  writeFileSync(path, JSON.stringify({ version: 1, entries: [
    { key: 'profile:AAPL', fetched: NOW, data: { profile: { symbol: 'AAPL' }, iconPath: null } },
    { key: 'profile:NVDA', fetched: NOW - 8 * 86400000, data: { profile: { symbol: 'NVDA' }, iconPath: null } },
    { key: 'profile:NVDA', fetched: NOW, data: { profile: { symbol: 'NVDA', apiKey: 'MALICIOUS' }, iconPath: 'https://evil.example/icon.png' } },
  ] }));
  const service = createStocksMarketDataService({ apiKey: 'fixture', profileCachePath: path, catalog: catalog('NVDA'), now: () => NOW, fetch: async () => { calls++; return response(profile('NVDA')); } });
  assert.equal((await service.profile('NVDA')).data?.marketCap, '123456789');
  assert.equal(calls, 1);
  assert.ok(!readFileSync(path, 'utf8').includes('MALICIOUS'));
});

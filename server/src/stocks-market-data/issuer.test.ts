import assert from 'node:assert/strict';
import test from 'node:test';
import { issuerFundamentals } from './issuer.js';
import { createStocksMarketDataService } from './service.js';
import { CURATED_40_CATALOG } from '../stocks-market-runtime/catalog.js';
import { IssuerTransport } from './transport.js';
const now = Date.parse('2026-09-21T04:00:00Z');
const header = 'Fund Name,Fund Ticker,CUSIP,Net Assets,Shares Outstanding,Rate Date';
const dram = `${header}\r\n"Roundhill, Memory ETF",DRAM,77926X320,25855926611.57,434730000.000,09/18/2026\r\n`;
const ram = `${header}\r\nRAM,RAM,26923V415,607882500.70,45000000.000,09/18/2026\r\n`;
test('issuer files preserve exact values, bind ticker and CUSIP, require a recent valid date', () => {
  const d = issuerFundamentals(dram, 'DRAM', now);
  assert.equal(d.aum, '25855926611.57'); assert.equal(d.sharesOutstanding, '434730000'); assert.equal(d.aumAsOf, '2026-09-18');
  assert.equal(issuerFundamentals(ram, 'RAM', now).issuerFundamentals.source, 'REX Shares');
  for (const bad of [dram.replace('77926X320', '26923V415'), dram.replace('09/18/2026', '09/31/2026'), dram.replace('09/18/2026', '09/22/2026'), dram.replace('09/18/2026', '09/01/2026'), dram.replace('25855926611.57', 'NaN'), dram.replace('25855926611.57', '-1'), dram.replace('434730000.000', '0'), dram + dram.split('\r\n')[1], '<html>failure</html>']) assert.throws(() => issuerFundamentals(bad, 'DRAM', now));
  assert.throws(() => issuerFundamentals(dram, 'RAM', now));
});
test('public issuer transport sends no credentials, only fixed files, with bounds and a separate budget', async () => {
  let count = 0;
  const transport = new IssuerTransport({ now: () => now, fetch: async (url, init) => {
    count++; assert.equal(new URL(String(url)).origin, 'https://www.roundhillinvestments.com');
    assert.ok(['/assets/data/filepointroundhill.40ru.ru_dailynav.csv', '/assets/data/rex_data/getrexnav.php'].includes(new URL(String(url)).pathname));
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    assert.equal(new Headers(init?.headers).get('APCA-API-KEY-ID'), null); assert.equal(init?.redirect, 'error');
    return new Response(dram, { headers: { 'content-type': 'text/csv' } });
  } });
  await transport.daily('DRAM'); await transport.daily('RAM');
  await assert.rejects(transport.daily('DRAM'), /REQUEST_BUDGET_EXHAUSTED/);
  await assert.rejects(transport.daily('../DRAM'), /NOT_FOUND/); assert.equal(count, 2);
  const large = new IssuerTransport({ fetch: async () => new Response('x'.repeat(128 * 1024 + 1), { headers: { 'content-type': 'text/csv' } }) });
  await assert.rejects(large.daily('DRAM'), /RESPONSE_TOO_LARGE/);
});
test('service enriches missing DRAM/RAM AUM daily without discarding a profile on issuer failure', async () => {
  let clock = now; let issuerCalls = 0; let fail = false;
  const service = createStocksMarketDataService({ apiKey: 'TEST', catalog: CURATED_40_CATALOG, etfGlobalEnabled: false, issuerFundamentalsEnabled: true, now: () => clock, fetch: async url => {
    const u = new URL(String(url));
    if (u.hostname === 'api.massive.com') {
      const ticker = u.pathname.split('/').pop();
      return new Response(JSON.stringify({ status: "OK", results: { ticker, name: ticker, market: 'stocks', locale: 'us', currency_name: 'usd', type: 'ETF' } }), { headers: { 'content-type': 'application/json' } });
    }
    issuerCalls++; if (fail) return new Response('', { status: 503 });
    return new Response(u.pathname.endsWith('.csv') ? dram : ram, { headers: { 'content-type': 'text/plain' } });
  } });
  const results = await Promise.all(Array.from({ length: 8 }, () => service.profile('DRAM')));
  assert.equal(issuerCalls, 1); assert.ok(results.every(r => r.data?.aum === '25855926611.57'));
  assert.equal((await service.profile('RAM')).data?.aum, '607882500.7'); assert.equal(issuerCalls, 2);
  await service.profile('SOXL'); assert.equal(issuerCalls, 2);
  clock += 86400001; fail = true;
  const failed = await service.profile('DRAM');
  assert.equal(failed.status, 'AVAILABLE'); assert.equal(failed.data?.aum, null); assert.equal(failed.data?.symbol, 'DRAM');
});

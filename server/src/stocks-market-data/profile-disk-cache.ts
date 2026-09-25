import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, dirname } from 'node:path';
import type { CompanyProfile } from './contracts.js';
import type { InternalProfile } from './normalize.js';
import { brandingPath } from './transport.js';

// Only normalized public facts are persisted. In particular, provider bodies, transport
// headers, credentials, quotes and charts never enter this file.
type CachedIssuer = { aum: string; aumAsOf: string; sharesOutstanding: string; issuerFundamentals: { source: string; sourceUrl: string; asOf: string } };
export type ProfileCacheValue = InternalProfile | { aum: string | null; aumAsOf: string | null } | CachedIssuer;
export type ProfileCacheEntry = { data: ProfileCacheValue; fetched: number };
const MAX_BYTES = 1024 * 1024;
const MAX_AGE = 7 * 86400000;
const DECIMAL = /^(?:0|[1-9]\d{0,29})(?:\.\d{1,18})?$/;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max: number): string | null => typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
const nullableText = (value: unknown, max: number): string | null | undefined => value === null ? null : text(value, max) ?? undefined;
const amount = (value: unknown): string | null | undefined => value === null ? null : typeof value === 'string' && DECIMAL.test(value) ? value : undefined;
function date(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? value : undefined;
}
function httpsUrl(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.href === value ? value : undefined; }
  catch { return undefined; }
}
function assets(value: unknown): { aum: string | null; aumAsOf: string | null } | null {
  const row = record(value); if (!row) return null;
  const aum = amount(row.aum), aumAsOf = date(row.aumAsOf);
  return aum === undefined || aumAsOf === undefined ? null : { aum, aumAsOf };
}
function publicProfile(value: unknown, symbol: string): CompanyProfile | null {
  const row = record(value); if (!row || row.symbol !== symbol || row.currency !== 'USD') return null;
  const name = text(row.name, 200), description = nullableText(row.description, 12000), exchange = nullableText(row.exchange, 100), securityType = nullableText(row.securityType, 100), marketCap = amount(row.marketCap), sharesOutstanding = amount(row.sharesOutstanding), website = httpsUrl(row.website), industry = nullableText(row.industry, 500), sourceDate = date(row.sourceDate);
  const logoUrl = row.logoUrl === null ? null : row.logoUrl === `/api/v1/stocks/market/${symbol}/logo` ? row.logoUrl : undefined;
  if (!name || description === undefined || exchange === undefined || securityType === undefined || marketCap === undefined || sharesOutstanding === undefined || website === undefined || industry === undefined || sourceDate === undefined || logoUrl === undefined) return null;
  return { symbol, name, description, exchange, securityType, currency: 'USD', marketCap, sharesOutstanding, website, industry, logoUrl, sourceDate };
}
export function validateProfileCacheValue(value: unknown, key: string, symbols: ReadonlySet<string>): ProfileCacheValue | null {
  const [kind, symbol, extra] = key.split(':');
  if (extra !== undefined || !symbols.has(symbol)) return null;
  if (kind === 'profile') {
    const row = record(value); if (!row) return null;
    const profile = publicProfile(row.profile, symbol); if (!profile) return null;
    const iconPath = row.iconPath === null ? null : typeof row.iconPath === 'string' && brandingPath(`https://api.massive.com${row.iconPath}`) === row.iconPath ? row.iconPath : undefined;
    if (iconPath === undefined || Boolean(iconPath) !== Boolean(profile.logoUrl)) return null;
    return { profile, iconPath };
  }
  if (kind === 'aum') return assets(value);
  if (kind === 'issuer' && (symbol === 'DRAM' || symbol === 'RAM')) {
    const row = record(value), asset = assets(value), source = record(row?.issuerFundamentals);
    const sharesOutstanding = amount(row?.sharesOutstanding);
    if (!asset?.aum || !asset.aumAsOf || !sharesOutstanding || !source) return null;
    const expected = symbol === 'DRAM' ? { source: 'Roundhill', sourceUrl: 'https://www.roundhillinvestments.com/etf/dram/' } : { source: 'REX Shares', sourceUrl: 'https://www.rexshares.com/ram/' };
    if (source.source !== expected.source || source.sourceUrl !== expected.sourceUrl || source.asOf !== asset.aumAsOf) return null;
    return { ...asset, sharesOutstanding, issuerFundamentals: { ...expected, asOf: asset.aumAsOf } };
  }
  return null;
}

export function profileCachePath(path: string): string {
  if (!isAbsolute(path) || !path.endsWith('.json') || path.length > 2048) throw new Error('INVALID_MARKET_DATA_CONFIG');
  return path;
}

/** A bad or old local file is ignored; the provider remains the source of truth. */
export function loadProfileDiskCache(path: string, symbols: ReadonlySet<string>, now: number): Map<string, ProfileCacheEntry> {
  const result = new Map<string, ProfileCacheEntry>();
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_BYTES) return result;
    const root = record(JSON.parse(readFileSync(path, 'utf8')));
    if (root?.version !== 1 || !Array.isArray(root.entries) || root.entries.length > symbols.size * 3) return result;
    for (const input of root.entries) {
      const row = record(input), key = row?.key, fetched = row?.fetched;
      if (typeof key !== 'string' || typeof fetched !== 'number' || !Number.isSafeInteger(fetched) || fetched > now || now - fetched > MAX_AGE || result.has(key)) continue;
      const data = validateProfileCacheValue(row?.data, key, symbols);
      if (data !== null) result.set(key, { data, fetched });
    }
  } catch { /* Optional cache: malformed or inaccessible files never become market facts. */ }
  return result;
}

/** Atomic replacement makes a process interruption leave either the old or new complete cache. */
export function saveProfileDiskCache(path: string, symbols: ReadonlySet<string>, entries: ReadonlyMap<string, ProfileCacheEntry>, now: number): void {
  const rows: { key: string; fetched: number; data: ProfileCacheValue }[] = [];
  for (const [key, entry] of entries) {
    if (!Number.isSafeInteger(entry.fetched) || entry.fetched > now || now - entry.fetched > MAX_AGE) continue;
    const data = validateProfileCacheValue(entry.data, key, symbols);
    if (data !== null) rows.push({ key, fetched: entry.fetched, data });
  }
  const body = JSON.stringify({ version: 1, entries: rows });
  if (Buffer.byteLength(body) > MAX_BYTES) return;
  let temporary: string | null = null;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } catch { if (temporary) try { unlinkSync(temporary); } catch { /* Already renamed or inaccessible. */ } }
}

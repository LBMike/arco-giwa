// Public company facts in Postgres: the market data service's validated profile, AUM and issuer entries (market cap,
// shares outstanding, name, logo path, fund assets), so a server restart restores the Mkt Cap column at once instead of
// refetching all 40 symbols within the free plan's few lookups a minute. Only these keys are read or written: quotes
// and charts keep their in-memory behaviour. The rows hold what the market page shows anyway; never a provider body,
// key or anything per user. The table comes from the stocks_market_profiles migration.
import type { MarketSnapshot, MarketSnapshotStore } from './snapshot-store.js';

/** The two statements the store runs, so tests can stand in for the database. */
export interface ProfileStoreSql {
  rows(text: string, values: readonly unknown[]): Promise<Record<string, unknown>[]>;
  execute(text: string, values: readonly unknown[]): Promise<unknown>;
}

const TABLE = 'arco_evm."StocksMarketProfile"';
const SCOPE = /^[a-f0-9]{64}$/;
/** profile:NVDA, aum:SOXL, issuer:DRAM. The migration's CHECK holds the same pattern. */
export const PROFILE_STORE_KEY = /^(?:profile|aum|issuer):[A-Z][A-Z0-9.-]{0,13}$/;
const MAX_BYTES = 1024 * 1024;

export function isProfileStoreKey(key: string): boolean {
  return PROFILE_STORE_KEY.test(key);
}

const time = (value: unknown): number | null => {
  const n = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

export function createSqlProfileStore(sql: ProfileStoreSql): MarketSnapshotStore {
  return {
    async read(scope, key) {
      if (!SCOPE.test(scope) || !isProfileStoreKey(key)) return null;
      const [row] = await sql.rows(`SELECT data, "fetchedAt"::text AS "fetchedAt", "sourceTimestamp"::text AS "sourceTimestamp" FROM ${TABLE} WHERE scope = $1 AND "key" = $2`, [scope, key]);
      if (!row) return null;
      const fetchedAt = time(row.fetchedAt);
      const sourceTimestamp = row.sourceTimestamp === null ? null : time(row.sourceTimestamp);
      if (fetchedAt === null || (row.sourceTimestamp !== null && sourceTimestamp === null)) return null;
      // JSONB normally arrives parsed; a driver that hands back text is parsed here. Either way the service validates
      // the data against the catalog before any of it reaches a response.
      let data = row.data;
      if (typeof data === 'string') try { data = JSON.parse(data); } catch { return null; }
      return { data, fetchedAt, sourceTimestamp };
    },
    async write(scope, key, snapshot: MarketSnapshot) {
      // Quotes and charts are not kept here.
      if (!SCOPE.test(scope) || !isProfileStoreKey(key)) return;
      if (time(snapshot.fetchedAt) === null || (snapshot.sourceTimestamp !== null && time(snapshot.sourceTimestamp) === null)) throw new Error('INVALID_MARKET_PROFILE_SNAPSHOT');
      const body = JSON.stringify(snapshot.data);
      if (body === undefined || Buffer.byteLength(body) > MAX_BYTES) throw new Error('INVALID_MARKET_PROFILE_SNAPSHOT');
      // An older fetch never replaces a newer one (two instances, or a slow write finishing late).
      await sql.execute(
        `INSERT INTO ${TABLE} (scope, "key", data, "fetchedAt", "sourceTimestamp") VALUES ($1, $2, $3::jsonb, $4::bigint, $5::bigint)
         ON CONFLICT (scope, "key") DO UPDATE SET data = EXCLUDED.data, "fetchedAt" = EXCLUDED."fetchedAt", "sourceTimestamp" = EXCLUDED."sourceTimestamp", "updatedAt" = clock_timestamp()
         WHERE ${TABLE}."fetchedAt" <= EXCLUDED."fetchedAt"`,
        [scope, key, body, String(snapshot.fetchedAt), snapshot.sourceTimestamp === null ? null : String(snapshot.sourceTimestamp)],
      );
    },
  };
}

/** The server's Prisma client as the store's SQL port (parameters are always bound, never interpolated). */
export function prismaProfileStoreSql(prisma: {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}): ProfileStoreSql {
  return {
    rows: (text, values) => prisma.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values),
    execute: (text, values) => prisma.$executeRawUnsafe(text, ...values),
  };
}

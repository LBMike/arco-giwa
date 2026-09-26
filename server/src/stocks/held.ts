// Held payments: direct Buy payments (tUSDC) and direct Sell escrows (NVDA) that the observer recorded without
// creating an order. They are StocksFunding / StocksCustody rows whose orderId is NULL. When the key was a direct
// order key, the DIRECT_ORDER_NOT_CREATED audit entry says why (its `hold`). Read-only: this module never writes,
// and returning or refunding a held payment is out of scope (it needs the signer and a two-person approval).
import { StocksError, type SqlPool } from './contracts.js';
import { DIRECT_HOLDS, type DirectHold } from './direct.js';

export type StocksHeldPayment = {
  /** StocksFunding.id (BUY) or StocksCustody.id (SELL). */
  readonly id: string;
  /** BUY: a tUSDC payment held without an order. SELL: an NVDA escrow held without an order. */
  readonly side: 'BUY' | 'SELL';
  readonly wallet: string;
  /** tUSDC base units (BUY only). */
  readonly cashAmount: string | null;
  /** NVDA base units (SELL only). */
  readonly quantity: string | null;
  readonly txHash: string;
  /** Why a direct order was not created (DIRECT_ORDER_NOT_CREATED). Null when none was recorded. */
  readonly hold: DirectHold | null;
  /** The recorded row reason, e.g. UNIDENTIFIED_ORDER or UNATTRIBUTED_TRANSFER. */
  readonly reason: string;
  readonly status: string;
  readonly createdAt: string;
};

export type HeldQuery = { readonly limit: number; readonly cursor: HeldCursor | null };
type HeldCursor = { readonly t: string; readonly s: 'BUY' | 'SELL'; readonly i: string };

export const HELD_DEFAULT_LIMIT = 50;
export const HELD_MAX_LIMIT = 100;
const INVALID = 'INVALID_HELD_QUERY';
const HOLDS: readonly string[] = DIRECT_HOLDS;
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function invalid(): never { throw new StocksError(INVALID, 400); }

export function encodeHeldCursor(cursor: HeldCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.t, s: cursor.s, i: cursor.i }), 'utf8').toString('base64url');
}

function decodeHeldCursor(value: unknown): HeldCursor {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { invalid(); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  const { t, s, i, ...rest } = parsed as Record<string, unknown>;
  if (Object.keys(rest).length > 0) invalid();
  if (typeof t !== 'string' || !CURSOR_TIME.test(t) || !Number.isFinite(Date.parse(t))) invalid();
  if (s !== 'BUY' && s !== 'SELL') invalid();
  if (typeof i !== 'string' || i.length === 0 || i.length > 200) invalid();
  return { t, s, i };
}

/** `?limit=1..100&cursor=<nextCursor>`; anything else is rejected. */
export function parseHeldQuery(query: unknown): HeldQuery {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) invalid();
  const { limit, cursor, ...rest } = query as Record<string, unknown>;
  if (Object.keys(rest).length > 0) invalid();
  let parsedLimit = HELD_DEFAULT_LIMIT;
  if (limit !== undefined) {
    if (typeof limit !== 'string' || !/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > HELD_MAX_LIMIT) invalid();
    parsedLimit = Number(limit);
  }
  return { limit: parsedLimit, cursor: cursor === undefined ? null : decodeHeldCursor(cursor) };
}

// Newest first across both tables; ties broken by side then id so pages never overlap. The audit lookup runs only
// for the rows of the page.
const HELD_SQL = `
WITH held AS (
  SELECT 'BUY'::text AS side, f.id, f.payer AS wallet, f.amount::text AS "cashAmount", NULL::text AS quantity,
         f."txHash", f.reason, f.status, f."createdAt"
    FROM arco_evm."StocksFunding" f
   WHERE f."orderId" IS NULL AND f."deploymentDigest" = $1
  UNION ALL
  SELECT 'SELL'::text, c.id, c.payer, NULL::text, c.quantity::text, c."txHash", c.reason, c.status, c."createdAt"
    FROM arco_evm."StocksCustody" c
   WHERE c."orderId" IS NULL AND c."deploymentDigest" = $1
), page AS (
  SELECT h.*, to_char(h."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime"
    FROM held h
   WHERE $2::timestamptz IS NULL OR (h."createdAt", h.side, h.id) < ($2::timestamptz, $3::text, $4::text)
   ORDER BY h."createdAt" DESC, h.side DESC, h.id DESC
   LIMIT $5
)
SELECT p.*, (
  SELECT a.detail->>'hold' FROM arco_evm."StocksAudit" a
   WHERE a.action = 'DIRECT_ORDER_NOT_CREATED' AND a."deploymentDigest" = $1
     AND a.detail->>(CASE WHEN p.side = 'BUY' THEN 'fundingId' ELSE 'custodyId' END) = p.id
   ORDER BY a."createdAt", a.id
   LIMIT 1
) AS hold
  FROM page p
 ORDER BY p."createdAt" DESC, p.side DESC, p.id DESC`;

export async function readHeldPayments(source: { pool: Pick<SqlPool, 'query'>; deploymentDigest: string }, query: HeldQuery): Promise<{
  items: StocksHeldPayment[];
  nextCursor: string | null;
}> {
  const { cursor, limit } = query;
  const rows = (await source.pool.query(HELD_SQL, [
    source.deploymentDigest, cursor?.t ?? null, cursor?.s ?? null, cursor?.i ?? null, limit + 1,
  ])).rows as Record<string, unknown>[];
  const page = rows.slice(0, limit);
  const items = page.map((row): StocksHeldPayment => ({
    id: String(row.id),
    side: row.side === 'SELL' ? 'SELL' : 'BUY',
    wallet: String(row.wallet),
    cashAmount: row.side === 'SELL' ? null : String(row.cashAmount),
    quantity: row.side === 'SELL' ? String(row.quantity) : null,
    txHash: String(row.txHash),
    hold: typeof row.hold === 'string' && HOLDS.includes(row.hold) ? (row.hold as DirectHold) : null,
    reason: String(row.reason),
    status: String(row.status),
    createdAt: new Date(row.createdAt as string).toISOString(),
  }));
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last
    ? encodeHeldCursor({ t: String(last.cursorTime), s: last.side === 'SELL' ? 'SELL' : 'BUY', i: String(last.id) })
    : null;
  return { items, nextCursor };
}

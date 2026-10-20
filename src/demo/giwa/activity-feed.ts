import { formatUnits } from "viem"
import { tokenSymbolFor, vaultConfigOf, vaultDisplayName, vaultImageFor } from "./catalog"
import { formatCash, formatQuantity } from "./stocks-investor/display"
import { orderStatusMeaning } from "./stocks-investor/status"
import type { StocksActivityEntry } from "./stocks-investor/types"
import { curatedStock, stockLogoPath } from "./stocks-market/curated"
import type { GiwaActivity, GiwaCatalogItem, GiwaRedemption } from "./types"

// Builds the personal-portfolio Activity feed. Two streams merge into ONE time-ordered list,
// de-duplicated so a redemption never appears twice:
//   • deposits + INSTANT redeems come from indexed on-chain events (EvmIndexedEvent);
//   • request-based redemptions come from IndexedRedemptionRequest ONLY — the matching
//     ProductRedeemRequested/Fulfilled/Claimed events are intentionally excluded.
// Every Amount is the product-token share count (18-dec); every vault is resolved config-first
// via the shared catalog resolver so identity matches the vault list / holdings table.

const SHARE_DECIMALS = 18

export type ActivityKind = "deposit" | "request" | "pending" | "complete" | "stock"

// Figma-verbatim labels + token tone classes (mirror redemptionBadge in components.tsx).
const TYPE_LABEL: Record<ActivityKind, string> = {
  deposit: "Deposit",
  request: "Redemption request",
  pending: "Pending",
  complete: "Redemption complete",
  stock: "Stocks",
}
const TYPE_TONE: Record<ActivityKind, string> = {
  deposit: "text-[var(--color-arco-text-soft)]",
  request: "text-[var(--color-arco-text-soft)]",
  pending: "text-[var(--color-arco-text-soft)]",
  complete: "text-[var(--color-arco-up)]",
  stock: "text-[var(--color-arco-text-soft)]",
}

// A completed Stocks sell reads red, like a falling price; a completed buy keeps the "complete" green.
const SELL_TONE = "text-[var(--color-arco-down)]"

// A redemption request whose status is one of these has paid out → "Redemption complete".
// Otherwise: REQUESTED → "Redemption request" (awaiting operator action), SETTLING (and any
// unknown status) → "Pending" (payout in flight).
const COMPLETE_STATUSES = new Set(["SETTLED", "FULFILLED", "CLAIMED", "COMPLETED"])

export type ActivityProduct = {
  productId: string | null
  symbol: string
  name: string
  imageUrl: string | undefined
  category: string | null
}

export type ActivityRow = {
  key: string
  kind: ActivityKind
  typeLabel: string
  typeTone: string
  date: string // "2026-07-11 12:33:12" (UTC), or "—" when unknown
  sortTs: number // ms epoch for ordering; 0 when unknown (sinks to the bottom until backfilled)
  product: ActivityProduct
  amount: string // human token count + symbol, e.g. "1.5 bEQTY"
  txHash: string | null
}

function toBigIntSafe(value: unknown): bigint {
  if (typeof value === "bigint") return value
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === "string" && value.trim() !== "") {
    try {
      return BigInt(value)
    } catch {
      return 0n
    }
  }
  return 0n
}

function argString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined
}

// Human product-token count from a raw base-unit amount (18-dec shares), trimmed to <=6 places.
function shareCount(raw: unknown): number {
  return Number(formatUnits(toBigIntSafe(raw), SHARE_DECIMALS))
}
function trimShares(n: number): string {
  if (!Number.isFinite(n)) return "0"
  return n.toFixed(6).replace(/\.?0+$/, "") || "0"
}

// Full datetime "YYYY-MM-DD HH:MM:SS" in UTC. Block timestamps are UTC, and ISO slicing keeps
// the rendered value stable across viewer locales/timezones (toLocale* would not). Unknown → "—".
function formatDate(iso: string | null | undefined): { text: string; ts: number } {
  if (!iso) return { text: "—", ts: 0 }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return { text: "—", ts: 0 }
  return { text: date.toISOString().slice(0, 19).replace("T", " "), ts: date.getTime() }
}

// Resolve a vault config-first (admin displayName/image → legacy symbol/icon), matching an
// event's contractAddress against catalog vault/token addresses or a productId.
function resolveProduct(
  products: GiwaCatalogItem[],
  opts: { contractAddress?: string; productId?: string; fallbackSymbol?: string },
): ActivityProduct {
  const addr = (opts.contractAddress ?? "").toLowerCase()
  const product = products.find((item) => {
    if (opts.productId && item.productId === opts.productId) return true
    if (!addr) return false
    return [item.depositVaultAddress, item.redemptionVaultAddress, item.productTokenAddress].some(
      (candidate) => typeof candidate === "string" && candidate.toLowerCase() === addr,
    )
  })
  if (!product) {
    const symbol = opts.fallbackSymbol ?? "GIWA"
    return { productId: opts.productId ?? null, symbol, name: symbol, imageUrl: undefined, category: null }
  }
  return {
    productId: product.productId,
    symbol: tokenSymbolFor(product),
    name: vaultDisplayName(product),
    imageUrl: vaultImageFor(product),
    category: vaultConfigOf(product).category ?? null,
  }
}

function row(kind: ActivityKind, base: Omit<ActivityRow, "kind" | "typeLabel" | "typeTone">): ActivityRow {
  return { ...base, kind, typeLabel: TYPE_LABEL[kind], typeTone: TYPE_TONE[kind] }
}

// Deposits + instant redeems from indexed events. Every other eventName (including
// ProductRedeemRequested/Fulfilled/Claimed) is skipped so redemptions come solely from the
// request stream below — no double-appearance.
function rowFromEvent(event: GiwaActivity, index: number, products: GiwaCatalogItem[]): ActivityRow | null {
  const kind: ActivityKind | null =
    event.eventName === "ProductDeposit" ? "deposit" : event.eventName === "ProductRedeemInstant" ? "complete" : null
  if (!kind) return null
  const product = resolveProduct(products, {
    contractAddress: event.contractAddress,
    productId: argString(event.args, "productId"),
    fallbackSymbol: argString(event.args, "symbol"),
  })
  // Deposit → shares minted (sharesOut); instant redeem → shares burned (sharesIn).
  const rawShares = kind === "deposit" ? event.args.sharesOut : event.args.sharesIn
  const date = formatDate(event.blockTimestamp)
  return row(kind, {
    key: `evt:${event.txHash}:${index}`,
    date: date.text,
    sortTs: date.ts,
    product,
    amount: `${trimShares(shareCount(rawShares))} ${product.symbol}`,
    txHash: event.txHash || null,
  })
}

// Request-based redemptions: REQUESTED → Redemption request, SETTLING (or unknown) → Pending,
// SETTLED (and legacy FULFILLED/CLAIMED) → Redemption complete; dated by createdAt/settledAt.
function rowFromRedemption(redemption: GiwaRedemption, products: GiwaCatalogItem[]): ActivityRow {
  const status = String(redemption.status).toUpperCase()
  const complete = COMPLETE_STATUSES.has(status)
  const kind: ActivityKind = complete ? "complete" : status === "REQUESTED" ? "request" : "pending"
  const product = resolveProduct(products, { productId: redemption.productId, fallbackSymbol: undefined })
  const date = formatDate(complete ? redemption.settledAt ?? redemption.createdAt : redemption.createdAt)
  const txHash = complete ? redemption.settledTxHash ?? redemption.requestedTxHash : redemption.requestedTxHash
  return row(kind, {
    key: `redeem:${redemption.redemptionVaultAddress}:${redemption.requestId}`,
    date: date.text,
    sortTs: date.ts,
    product,
    amount: `${trimShares(shareCount(redemption.sharesIn))} ${product.symbol}`,
    txHash: txHash ?? null,
  })
}

// Stocks trades (GET /api/v1/stocks/activity/:wallet): one row per trade, dated when the wallet's own transaction was
// observed, linked to that transaction. The type says the server's state: Buy / Sell once settled, "processing" while
// it settles, "Held for review", or the returned outcome.
const STOCK_PRODUCT: ActivityProduct = {
  productId: null,
  symbol: "NVDA",
  name: curatedStock("NVDA")?.name ?? "NVDA",
  imageUrl: stockLogoPath("NVDA") ?? undefined,
  category: "Stocks",
}

export function stockTypeLabel(entry: StocksActivityEntry): { label: string; tone: string } {
  const sell = entry.side === "SELL"
  const category = orderStatusMeaning({ side: entry.side, state: entry.state }).category
  switch (category) {
    case "COMPLETED":
      return { label: sell ? "Sell" : "Buy", tone: sell ? SELL_TONE : TYPE_TONE.complete }
    case "RETURNED":
      return { label: sell ? "Sell returned" : "Buy refunded", tone: TYPE_TONE.stock }
    case "EXPIRED":
      return { label: "Sell expired", tone: TYPE_TONE.stock }
    case "REVIEW_REQUIRED":
    case "DEADLINE_PASSED":
      return { label: "Held for review", tone: TYPE_TONE.stock }
    default:
      return { label: sell ? "Sell processing" : "Buy processing", tone: TYPE_TONE.stock }
  }
}

export function stockActivityRow(entry: StocksActivityEntry): ActivityRow {
  const { label, tone } = stockTypeLabel(entry)
  const date = formatDate(entry.createdAt)
  const parts = [
    entry.quantity !== "0" ? `${formatQuantity(entry.quantity)} NVDA` : null,
    entry.cashAmount !== "0" ? `${formatCash(entry.cashAmount)} USDC` : null,
  ].filter((part): part is string => part !== null)
  return {
    key: `stock:${entry.side}:${entry.paymentTx}`,
    kind: "stock",
    typeLabel: label,
    typeTone: tone,
    date: date.text,
    sortTs: date.ts,
    product: STOCK_PRODUCT,
    amount: parts.join(" · ") || "—",
    txHash: entry.paymentTx,
  }
}

export function buildActivityFeed(
  events: GiwaActivity[],
  redemptions: GiwaRedemption[],
  products: GiwaCatalogItem[],
  stocks: StocksActivityEntry[] = [],
): ActivityRow[] {
  const fromEvents = events.map((event, index) => rowFromEvent(event, index, products)).filter((r): r is ActivityRow => r !== null)
  const fromRedemptions = redemptions.map((redemption) => rowFromRedemption(redemption, products))
  const fromStocks = stocks.map(stockActivityRow)
  // Newest first. Rows with an unknown date (sortTs 0 — un-backfilled events) sink to the bottom.
  return [...fromEvents, ...fromRedemptions, ...fromStocks].sort((a, b) => b.sortTs - a.sortTs)
}

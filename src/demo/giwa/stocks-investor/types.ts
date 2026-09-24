// GIWA Stocks investor module — wire and host contract types.
//
// The shapes below mirror the actual server implementation at this commit
// (server/src/stocks/plugin.ts, service.ts, sell-service.ts, repository.ts and the
// Stocks migrations), not an idealised API:
//   • GET /api/v1/stocks/catalog is a TOP-LEVEL object (no envelope).
//   • Every other route answers { ...profile, observedAt, data }.
//   • BUY quote/order rows carry no `side`; SELL rows carry side: "SELL".
//   • Quantities (scale 9) and cash amounts (scale 6) are integer base-unit strings.

export const GIWA_STOCKS_CHAIN_ID = 91342 as const
export const STOCKS_QUANTITY_SCALE = 9
export const STOCKS_CASH_SCALE = 6

export type HexAddress = `0x${string}`

/** Integer base units as a canonical decimal string ("0", "120000000"). Never a JS number. */
export type BaseUnits = string

export type StocksProfile = {
  profile: "DEMO_TESTNET"
  valuePolicy: "TEST_VALUE_ONLY"
  brokerMode: "MOCK_BROKER"
  chainId: typeof GIWA_STOCKS_CHAIN_ID
  priceSource: "FIXED_MOCK_PRICE"
}

export type StocksOrderCapability = "CHECK_PAUSE_AT_ORDER" | "NOT_ACTIVATED"

export type StocksInstrument = {
  symbol: "NVDA"
  quantityScale: typeof STOCKS_QUANTITY_SCALE
  /** Human decimal price in cash units, e.g. "120.000000". */
  price: string
  priceSource: "FIXED_MOCK_PRICE"
  orderCapability: StocksOrderCapability
}

export type StocksCashSymbol = "ARCO_TEST_USDC" | "ARCO_TEST_RLUSD"

export type StocksCatalog = StocksProfile & {
  instruments: StocksInstrument[]
  cashSymbol: StocksCashSymbol
  deploymentId: string
  observedAt: string
}

export type StocksSide = "BUY" | "SELL"

export const BUY_ORDER_STATES = [
  "AWAITING_FUNDING",
  "FUNDED_QUOTE_EXPIRED",
  "FUNDING_REVIEW_REQUIRED",
  "BROKER_PENDING",
  "BROKER_UNKNOWN",
  "MINT_QUEUED",
  "MINT_SUBMITTED",
  "MINT_FINALITY_PENDING",
  "MINT_UNKNOWN",
  "COMPLETED",
  "REFUNDED",
  "REVIEW_REQUIRED",
] as const

export const SELL_ORDER_STATES = [
  "AWAITING_ESCROW",
  "EXPIRED",
  "ESCROW_HELD",
  "ESCROW_REVIEW_REQUIRED",
  "LIQUIDITY_PENDING",
  "SELL_BROKER_PENDING",
  "SELL_BROKER_UNKNOWN",
  "SELL_PARTIAL_HELD",
  "REDEEM_QUEUED",
  "RETURN_QUEUED",
  "SETTLEMENT_PENDING",
  "SETTLEMENT_UNKNOWN",
  "COMPLETED",
  "RETURNED",
  "REVIEW_REQUIRED",
] as const

export type BuyOrderState = (typeof BUY_ORDER_STATES)[number]
export type SellOrderState = (typeof SELL_ORDER_STATES)[number]

/** A validated quote. `side` is added by the client for BUY rows, which carry none on the wire. */
export type StocksQuote = {
  side: StocksSide
  id: string
  actorId: string
  wallet: HexAddress
  symbol: "NVDA"
  quantity: BaseUnits
  cashAmount: BaseUnits
  deploymentDigest: string
  expiresAt: string
  createdAt: string
}

type StocksOrderBase = {
  id: string
  orderKey: string
  quoteId: string
  actorId: string
  wallet: HexAddress
  symbol: "NVDA"
  quantity: BaseUnits
  cashAmount: BaseUnits
  idempotencyKey: string
  deploymentId: string
  deploymentDigest: string
  quoteExpiresAt: string
  version: number
  createdAt: string
  updatedAt: string
}

export type StocksBuyOrder = StocksOrderBase & { side: "BUY"; state: BuyOrderState }
export type StocksSellOrder = StocksOrderBase & { side: "SELL"; state: SellOrderState }
export type StocksOrder = StocksBuyOrder | StocksSellOrder

export type StocksHolding = {
  wallet: HexAddress
  symbol: "NVDA"
  /** Finalized units in the wallet. Includes reservedQuantity. Signed: the server does not clamp a deficit. */
  walletQuantity: string
  /** Units held by the redemption escrow for sell orders. Not in the wallet. */
  escrowedQuantity: BaseUnits
  /** Part of walletQuantity reserved by accepted sell orders awaiting escrow. Not an extra asset. */
  reservedQuantity: BaseUnits
  /** walletQuantity − reservedQuantity. Signed: negative when more is reserved than the wallet holds. */
  availableQuantity: string
  /** walletQuantity + escrowedQuantity: the economic total, counted once. Signed. */
  quantity: string
}

export type StocksPendingOrder =
  | { id: string; side: "BUY"; state: BuyOrderState; quantity: BaseUnits; cashAmount: BaseUnits }
  | { id: string; side: "SELL"; state: SellOrderState; quantity: BaseUnits; cashAmount: BaseUnits }

export type StocksPortfolio = {
  holdings: StocksHolding[]
  pending: StocksPendingOrder[]
  projectionPolicy: "FINALIZED_RESTRICTED_TRANSFER_MOVEMENTS"
}

export type StocksEnvelope<T> = { observedAt: string; data: T }

export type StocksQuoteRequest = { symbol: "NVDA"; quantity: string }
export type StocksOrderRequest = { quoteId: string; idempotencyKey: string }

// ── host contract ──────────────────────────────────────────────────────────────

/**
 * Session supplied by the host. `verified` must only be passed after the host completed the
 * existing SIWE flow (POST /api/v1/auth/nonce → wallet signs → POST /api/v1/auth/verify) for
 * this exact wallet and received its token. A connected wallet alone is NOT a verified session.
 */
export type GiwaStocksSession =
  | { status: "signed-out" }
  | { status: "verified"; walletAddress: HexAddress; chainId: typeof GIWA_STOCKS_CHAIN_ID; token: string }

/** The host wallet's current account/chain (e.g. from useGiwaWallet()). Used only to detect a mismatch. */
export type GiwaStocksHostWallet = { address: string | null; chainId: number | null }

export type GiwaStocksTab = "stocks" | "orders" | "portfolio"

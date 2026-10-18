export type HexAddress = `0x${string}`

export type ContractDeployment = {
  proxy: HexAddress | null
  implementation?: HexAddress | null
  bytecodeHash?: string | null
}

export type GiwaAsset = {
  symbol: "tUSDC" | "tBTC" | "tXRP" | "tWETH" | string
  name: string
  decimals: number
  contract?: ContractDeployment
  tokenAddress?: HexAddress | string | null
  faucet?: HexAddress | null
  faucetAddress?: HexAddress | string | null
  deploymentBlock?: string | number | null
}

// Off-chain per-vault config merged into the catalog by the server (admin-ia-plan §2).
// Absent (older servers) => defaults: visible, not pinned, all card views on.
export type GiwaVaultConfig = {
  displayName: string | null
  category: string | null
  description: string | null
  adminDepositAddress: string | null
  cardSnapshot: boolean
  cardIndustry: boolean
  cardExposure: boolean
  pinned: boolean
  hidden: boolean
  // "product" (shown in Products) or "saving" (Savings page only, excluded from Products).
  kind: "product" | "saving"
  // Display profile (P1). null => the product detail page uses the legacy fallback.
  assetManagerName: string | null
  issuerName: string | null
  about: string | null
  aum: string | null
  redemptionTimelineDays: number | null
  feeInstantMintingBps: number | null
  feeInstantRedemptionBps: number | null
  feeManagementBps: number | null
  feePerformanceBps: number | null
  vaultImageUrl: string | null
  assetManagerImageUrl: string | null
  issuerImageUrl: string | null
  // "More info" docs links: URL + show toggle per slot (Documentation / Legal Terms / Risks).
  // A link renders on the detail only when shown AND the URL is set.
  docsUrl: string | null
  legalUrl: string | null
  risksUrl: string | null
  docsShown: boolean
  legalShown: boolean
  risksShown: boolean
  // Portfolio breakdowns (P3): slice arrays or null (fall back per view).
  portfolioSnapshot: GiwaPortfolioSlice[] | null
  portfolioIndustry: GiwaPortfolioSlice[] | null
  portfolioExposure: GiwaPortfolioSlice[] | null
  // Savings accept-assets (only meaningful for kind="saving"): ordered list or null.
  acceptAssets: GiwaAcceptAsset[] | null
}

export type GiwaPortfolioSlice = { label: string; percent: number; valueUsd?: number | null }

// A Savings-page accept-asset entry. `order` is the array index; `savingVaultId` is the owning
// saving vault's productId for a real asset, or null for a dummy (coming-soon) asset that maps to
// nothing yet (both derived at save). `isDummy` = display-only / coming-soon.
export type GiwaAcceptAsset = {
  symbol: string
  icon: string | null
  apy: number | null
  savingVaultId: string | null
  isDummy: boolean
  // Global cross-vault display order for the Savings selector (nullable int ≥0). Distinct from the
  // intra-vault array index; unset (null) sorts after ordered cards.
  sortOrder: number | null
}

// One products-page hero-carousel card. Name + logo are resolved config-first from the
// vault at render time (not stored here); only the card-scoped intro, show/hide state and
// carousel order live on the record. `shown=false` => hidden (a new card starts hidden).
export type GiwaFeaturedCard = {
  id: string
  productId: string
  about: string | null
  shown: boolean
  position: number
}

export type GiwaProduct = {
  productId: string
  symbol: string
  name: string
  paymentAssetSymbol: string
  paymentAssetAddress?: HexAddress | string | null
  productToken?: ContractDeployment
  productTokenAddress?: HexAddress | string | null
  depositVault?: ContractDeployment
  depositVaultAddress?: HexAddress | string | null
  redemptionVault?: ContractDeployment
  redemptionVaultAddress?: HexAddress | string | null
  priceFeed?: ContractDeployment
  priceFeedAddress?: HexAddress | string | null
  paymentAsset?: GiwaAsset | null
  activationFlags?: Record<string, boolean>
  deploymentBlock?: string | number | null
  vaultConfig?: GiwaVaultConfig | null
  // Partial: older servers omit the whole-vault fields; read it through pauseStateOf().
  pauseState?: Partial<GiwaPauseState> | null
}

// Pause snapshot attached by the catalog (server-side RPC read, no wallet needed, cached
// ~30s) and returned live by GET /api/v1/admin/pause-state. `*Paused` includes the
// whole-contract pause; `*VaultPaused` is that whole-contract pause alone (unpauseFn cannot
// lift it); `*Partial` = the two entry-path selectors of one kind disagree (a half-completed
// pause sequence — admin should retry).
export type GiwaPauseState = {
  depositPaused: boolean
  withdrawPaused: boolean
  depositPartial: boolean
  withdrawPartial: boolean
  depositVaultPaused: boolean
  withdrawVaultPaused: boolean
}

export type GiwaCatalogItem = GiwaProduct & {
  paymentAsset: GiwaAsset | null
  productTokenAddress: HexAddress | null
  paymentAssetAddress: HexAddress | null
  depositVaultAddress: HexAddress | null
  redemptionVaultAddress: HexAddress | null
  priceFeedAddress: HexAddress | null
}

export type GiwaRegistry = {
  chainId: 91342
  releaseId: string
  evmVersion: "cancun" | "shanghai" | "prague"
  deploymentBlock: string | number | null
  activationFlags: {
    deployed: boolean
    dryRun: boolean
    frontendEnabled: boolean
    indexerEnabled: boolean
  }
  assets: GiwaAsset[]
  products: GiwaProduct[]
  productPaymentMappings: Record<string, string>
  explorerBaseUrl: string
}

export type GiwaPortfolio = {
  walletAddress: string
  chainId: number
  positions: unknown[]
  redemptions: GiwaRedemption[]
}

export type GiwaActivity = {
  eventName: string
  txHash: string
  blockNumber: string | number
  // Emitting contract (vault/token) address — used to resolve the vault config-first by
  // matching catalog vault addresses. The activity endpoint returns it; older consumers ignored it.
  contractAddress?: string
  // Block wall-clock time (ISO string) captured by the indexer; null on rows not yet backfilled.
  blockTimestamp?: string | null
  args: Record<string, unknown>
}

export type GiwaRedemption = {
  requestId: string
  productId: string
  walletAddress: string
  redemptionVaultAddress: HexAddress | string
  sharesIn: string
  lockedAssetsOut: string
  status: "REQUESTED" | "FULFILLED" | "CLAIMED" | string
  requestedTxHash?: string
  fulfilledTxHash?: string | null
  claimedTxHash?: string | null
  /** Indexer row creation ≈ request time (ISO string, straight from Prisma createdAt). */
  createdAt?: string
  fulfilledAt?: string | null
  /** Part B (direct-transfer payout): settlement timestamp; replaces fulfilledAt in that model. */
  settledAt?: string | null
  /** Part B payout ERC20 transfer tx; the Activity "Transaction" link for a settled redemption. */
  settledTxHash?: string | null
  /** Admin pending list only: "arcousd-recall" = the ArcoUSD Reserve recalling its MMF position. */
  kind?: "customer" | "arcousd-recall"
  /** Admin pending list only: the Reserve strategy of an ArcoUSD recall (null when unmapped). */
  strategyId?: number | null
}

/** ArcoUSD Reserve recall with its on-chain state (GET /api/v1/admin/arcousd/recalls). */
export type GiwaReserveRecall = {
  productId: string
  requestId: string
  strategyId: number | null
  status: string
  state: "requested" | "settling" | "awaiting-acknowledgement" | "claimable" | "done" | "unknown"
  action: "acknowledge" | "claim" | null
  /** Asset base units the Reserve still counts as pending; null when unread. */
  pending: string | null
  open: boolean | null
  lockedAssetsOut: string | null
  settledTxHash: string | null
  createdAt: string | null
  warning: string | null
  error: string | null
}

// ── ArcoUSD (docs/specs/arcousd-v1.md §5) ─────────────────────────────────────────────
// Amounts: base units as decimal strings; `*Human` / `*Usd` are formatUnits strings (no rounding).

export type GiwaArcoUSDStatus = "not-deployed" | "live" | "unavailable"

export type GiwaArcoUSDAssetState = {
  symbol: string
  address: string
  decimals: number
  depositEnabled: boolean
  redeemEnabled: boolean
  instantFeeBps: number
  swapFeeBps: number
  balance: string
  queued: string
  available: string
  balanceHuman: string
  queuedHuman: string
  availableHuman: string
  queueLength: number
  queueHead: number
  queueBacklog: number
}

export type GiwaArcoUSDStrategyState = {
  strategyId: number
  productId: string | null
  asset: string
  productToken: string
  enabled: boolean
  shares: string
  value: string
  valueUsd: string
  navOk: boolean
  pendingRecall: string
  maxAllocation: string
}

export type GiwaArcoUSDBuyGate = {
  status: "inactive" | "open" | "closed"
  reason:
    | null
    | "not-deployed"
    | "read-failed"
    | "settlement-paused"
    | "buy-paused"
    | "mint-cap"
    | "insufficient-buffer"
    | "asset-missing"
    | "config-invalid"
  asset: string
  available: string | null
  threshold: string
  checkedAt: string
}

/** GET /api/v1/arcousd/reserve (public). */
export type GiwaArcoUSDReserve = {
  status: "not-deployed" | "live" | "unavailable"
  chainId: number
  contracts: null | { arcoUSD: string; reserve: string; lens: string; router: string | null; routerProducts: string[] }
  readAt: string
  reserve: null | {
    blockNumber: string
    totalBacking: string
    totalLiabilities: string
    totalBackingUsd: string
    totalLiabilitiesUsd: string
    surplus: string
    navOk: boolean
    mmfBps: number
    mmfTargetBps: number
    bufferFloorBps: number
    queueMinDelay: number
    mintCap: string
    reservePaused: boolean
    settlementPaused: boolean
    arcoUSDPaused: boolean
    arcoUSDBurnPaused: boolean
    depositPaused: boolean
    arcoUSDMintPaused: boolean
    routerPaused: boolean
    assets: GiwaArcoUSDAssetState[]
    strategies: GiwaArcoUSDStrategyState[]
  }
  gate: GiwaArcoUSDBuyGate
}

/** GET /api/v1/admin/arcousd/snapshots */
export type GiwaArcoUSDSnapshots = {
  status: GiwaArcoUSDStatus
  error?: string
  days: number
  total: number
  sampled: boolean
  /** The read stopped at 30,000 rows: the oldest part of the window is missing (latest kept). */
  truncated: boolean
  points: {
    takenAt: string
    blockNumber: string
    totalBackingUsd: string
    totalLiabilitiesUsd: string
    surplusUsd: string
    mmfBps: number
    navOk: boolean
    paused: boolean
    settlementPaused: boolean
  }[]
}

export type GiwaArcoUSDQueueRow = {
  requestId: string
  owner: string
  recipient: string
  asset: string
  symbol: string
  decimals: number | null
  status: "QUEUED" | "PAID" | "PAYOUT_FAILED" | "CANCELLED" | string
  arcoUSDAmount: string
  arcoUSDAmountHuman: string
  /** Net payout (after the swap fee). */
  assetAmount: string
  assetAmountHuman: string | null
  feeUsd: string | null
  requestedAt: string
  eligibleAt: string
  waitSeconds: number
  /** QUEUED past the T+2 target. */
  overdue: boolean
  queuedTxHash: string
  closedTxHash: string | null
  closedAt: string | null
}

export type GiwaArcoUSDQueueFilter = "open" | "all" | "QUEUED" | "PAID" | "PAYOUT_FAILED" | "CANCELLED"

/** GET /api/v1/admin/arcousd/queue */
export type GiwaArcoUSDQueue = {
  status: GiwaArcoUSDStatus
  error?: string
  filter: GiwaArcoUSDQueueFilter
  targetSeconds: number
  queueMinDelay: number
  /** chain: the live Reserve value; registry: the deploy-time value (live read unavailable). */
  queueMinDelaySource: "chain" | "registry"
  assets: {
    symbol: string
    asset: string
    decimals: number
    queuedCount: number
    queuedAmount: string
    queuedAmountHuman: string
    overdueCount: number
    failedCount: number
    oldestRequestedAt: string | null
    head: { requestId: string; assetAmount: string; assetAmountHuman: string; eligibleAt: string } | null
  }[]
  requests: GiwaArcoUSDQueueRow[]
  truncated: boolean
  summaryTruncated: boolean
}

export type GiwaArcoUSDFlowTotals = {
  depositsUsd: string
  instantRedemptionsUsd: string
  queuedRedemptionsUsd: string
  queuedPaidUsd: string
  settlementsUsd: string
  routerBuysUsd: string
  feesUsd: string
  deposits: number
  instantRedemptions: number
  queuedRedemptions: number
  queuedPaid: number
  settlements: number
  routerBuys: number
}

/** GET /api/v1/admin/arcousd/flows */
export type GiwaArcoUSDFlows = {
  status: GiwaArcoUSDStatus
  error?: string
  days: number
  since: string
  totals: GiwaArcoUSDFlowTotals
  daily: (GiwaArcoUSDFlowTotals & { day: string })[]
  byAsset: (GiwaArcoUSDFlowTotals & { symbol: string; asset: string })[]
  routerBuysByPayAsset: { symbol: string; count: number; volumeUsd: string }[]
  recent: {
    eventName: string
    contract: "reserve" | "router"
    txHash: string
    blockNumber: string
    logIndex: number
    at: string | null
    symbol: string | null
    account: string | null
    amountUsd: string | null
    feeUsd: string | null
  }[]
  truncated: boolean
  unknownAssetEvents: number
}

/** POST /api/v1/admin/arcousd/process-queue */
export type GiwaArcoUSDProcessQueue = {
  transaction: UnsignedAdminTransaction
  symbol: string
  maxCount: number
  /** Dry run of the same call: requests it would pay now, or why it could not be read. */
  preview: { paid: number; blockNumber: string } | { error: string }
}

export type FaucetStatus = {
  walletAddress: string
  chainId: number
  available: boolean
  reason: string | null
}

export type UiPhase =
  | "disconnected"
  | "wrong-network"
  | "loading-registry"
  | "missing-gas"
  | "missing-payment-token"
  | "allowance-required"
  | "approving"
  | "ready"
  | "simulating"
  | "submitting"
  | "confirming"
  | "success"
  | "pending-redemption"
  | "claimable"
  | "failed"

export type UnsignedAdminTransaction = {
  chainId: number
  to: HexAddress
  value: "0x0" | HexAddress | string
  data: HexAddress
  description: string
  simulation?: { status: string; reason?: string }
}

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
    /** Reserve.fnPaused(processQueue): queue payouts stop. Absent from older API builds. */
    queuePaused?: boolean
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

/** sArcoUSD (Savings) state: GET /api/v1/arcousd/savings (docs/specs/arcousd-v1.md §3.13–3.14). */
export type GiwaArcoUSDSavingsState = {
  blockNumber: string
  totalAssets: string
  totalAssetsUsd: string
  totalSupply: string
  /** ArcoUSD per 1 sArcoUSD, base18 / human. */
  sharePrice: string
  sharePriceHuman: string
  unvested: string
  unvestedUsd: string
  vestingAmount: string
  vestingPeriodSeconds: number
  vestingStartedAt: string | null
  vestingEndsAt: string | null
  /** ArcoUSD per second being released now, base18. */
  rewardRate: string
  currentAprBps: number
  currentApyBps: number
  seeded: boolean
  vaultPaused: boolean
  depositPaused: boolean
  withdrawPaused: boolean
  rewardsPaused: boolean
  depositsOpen: boolean
  withdrawalsOpen: boolean
  distributor: {
    paused: boolean
    /** Reserve.paused(): distribute() refuses. */
    reservePaused: boolean
    /** ArcoUSD paused() or fnPaused(mint): distribute() cannot mint. */
    arcoUSDMintPaused: boolean
    minIntervalSeconds: number
    maxAprBps: number
    reserveMarginBps: number
    lastDistributionAt: string
    nextDistributionAt: string
    preview: { amount: string; amountUsd: string; surplus: string; rateCap: string; mintHeadroom: string; navOk: boolean } | null
    /** "preview-unreadable" when preview() could not be read (the detail is in the API log). */
    previewError?: string
  }
}

export type GiwaArcoUSDSavings = {
  status: GiwaArcoUSDStatus
  chainId: number
  contracts: { sArcoUSD: string; distributor: string; zap: string; arcoUSD: string; reserve: string } | null
  readAt: string
  savings: GiwaArcoUSDSavingsState | null
}

/** GET /api/v1/arcousd/savings/history: share price / TVL from the savings indexer's snapshots. */
export type GiwaArcoUSDSavingsHistory = {
  status: GiwaArcoUSDStatus
  chainId: number
  days: number
  total: number
  sampled: boolean
  truncated: boolean
  points: { takenAt: string; blockNumber: string; sharePrice: string; totalAssetsUsd: string; aprBps: number }[]
  /** Share-price growth over the window, annualized (bps); null with under a day of history. */
  realizedApyBps: number | null
}

/** GET /api/v1/admin/arcousd/savings: distributions, top-ups, deposits/withdrawals, Zap use. */
export type GiwaArcoUSDSavingsAdmin = {
  status: GiwaArcoUSDStatus
  error?: string
  days: number
  contracts: { sArcoUSD: string; distributor: string; zap: string } | null
  totals: {
    depositsUsd: string
    deposits: number
    withdrawalsUsd: string
    withdrawals: number
    distributedUsd: string
    distributions: number
    toppedUpUsd: string
  }
  daily: { day: string; depositsUsd: string; withdrawalsUsd: string }[]
  distributions: { at: string | null; txHash: string; caller: string; amountUsd: string; surplusUsd: string; rateCapUsd: string; backingUsd: string; liabilitiesUsd: string }[]
  rewards: { at: string | null; txHash: string; caller: string; amountUsd: string; fromDistributor: boolean }[]
  activity: { at: string | null; txHash: string; kind: "deposit" | "withdraw" | "seed"; account: string; sender: string; amountUsd: string; viaZap: boolean }[]
  zapAssets: { asset: string; symbol: string; deposits: number; depositAmount: string; redemptions: number; redeemAmount: string }[]
  truncated: boolean
}

/** POST /api/v1/admin/arcousd/savings/distribute: the unsigned distribute() and its dry run. */
export type GiwaArcoUSDDistribute = {
  transaction: UnsignedAdminTransaction
  preview: { amountUsd: string; blockNumber: string } | { error: string }
}

/** One watcher alert (docs/operations/arcousd-alerts.md). PENDING: seen, not yet held long enough to send. */
export type GiwaArcoUSDAlert = {
  key: string
  severity: "CRITICAL" | "WARNING"
  status: "PENDING" | "OPEN" | "RESOLVED"
  title: string
  detail: string
  firstSeenAt: string
  lastSeenAt: string
  openedAt: string | null
  resolvedAt: string | null
  lastNotifiedAt: string | null
  notifyCount: number
  deliveryErrors: { channel: string; error: string }[]
}

export type GiwaArcoUSDAlerts = {
  status: GiwaArcoUSDStatus
  error?: string
  channels: { telegram: boolean; slack: boolean }
  /** ARCOUSD_ALERT_* settings that are set but invalid (keys only). */
  invalidSettings: string[]
  intervalMs: number
  /** `reconciled`: the last round compared the queue with the chain (null: not recorded). */
  watcher: null | { lastRunAt: string; lastOkAt: string | null; lastError: string | null; stale: boolean; reconciled?: boolean | null }
  /** Open (critical first), pending, then resolved in the last 24 hours. */
  alerts: GiwaArcoUSDAlert[]
}

/** The keeper's last report (docs/operations/arcousd-keeper.md): the queue, and Savings distributions. */
export type GiwaArcoUSDKeeperReport = {
  mode: "off" | "dry-run" | "live"
  address: string | null
  intervalMs: number
  batch: number
  gasBalanceWei: string | null
  lowGasWei: string
  lowGas: boolean | null
  canAffordTx: boolean | null
  /** false: this round stopped before asking the chain (waiting on a transaction, paused…). */
  simulated?: boolean
  /** What processQueue would pay now, per asset with a backlog. `clearing`: it would first step past
   *  cancelled / failed entries that fill the batch. */
  simulations: { symbol: string; paid: number | null; error: string | null; clearing?: boolean }[]
  lastTx: null | {
    hash: string
    /** Absent in reports from before Savings: processQueue. */
    action?: "processQueue" | "distribute"
    /** The asset paid, or "sArcoUSD" for distribute. */
    symbol: string
    nonce: number
    sentAt: string
    status: "pending" | "success" | "reverted" | "replaced" | "failed"
    paid: number | null
    /** distribute: ArcoUSD minted into sArcoUSD (decimal string). */
    amountUsd?: string | null
    blockNumber: string | null
    error: string | null
  }
  /** hash null: a pending transaction this keeper process did not send. */
  pending: null | { hash: string | null; nonce: number; since: string; stuck: boolean }
  /** Simulating only until then, after a reverted processQueue. */
  holdUntil?: string | null
  /** The Savings step (absent from keepers before Savings; null when the round stopped before it). */
  distribute?: GiwaArcoUSDKeeperDistribute | null
  /** No distribute() until then, after a reverted one. */
  distributeHoldUntil?: string | null
  note: string | null
}

/** What the keeper's Savings step found: see keeper.ts KeeperDistribute. */
export type GiwaArcoUSDKeeperDistribute = {
  state: "off" | "not-deployed" | "waiting" | "nothing" | "ready" | "sent" | "reverts" | "error"
  nextAt: string | null
  /** Would mint (waiting: accrued so far), or minted (sent); decimal string in ArcoUSD. */
  amountUsd: string | null
  detail: string | null
}

export type GiwaArcoUSDKeeper = {
  status: GiwaArcoUSDStatus
  error?: string
  keeper: null | { lastRunAt: string; lastOkAt: string | null; lastError: string | null; stale: boolean; report: GiwaArcoUSDKeeperReport | null }
}

export type GiwaArcoUSDAlertDelivery = Partial<Record<"telegram" | "slack", { ok: boolean; at: string; error?: string }>>

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

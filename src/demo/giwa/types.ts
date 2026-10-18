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

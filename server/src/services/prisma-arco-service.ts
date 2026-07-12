import { Prisma } from "@prisma/client"
import type {
  AuthNonceInput,
  ConsumeNonceInput,
  FaucetStatus,
  IndexerCursorInput,
  IndexedEventInput,
  RegistrySyncInput,
  RedemptionRequestIndexInput,
  WalletAttestationInput,
} from "./types.js"

// Nullable Json columns reject a bare JS null in Prisma writes — map null to the DbNull
// sentinel (SQL NULL). On read the sentinel never comes back from the real client (it
// deserializes to null); the check also normalizes the in-memory test harness.
function jsonNullableWrite(value: unknown) {
  return value == null ? Prisma.DbNull : (value as Prisma.InputJsonValue)
}
function readJsonSlices(value: unknown) {
  if (value == null || value === Prisma.DbNull || value === Prisma.JsonNull) return null
  return value as { label: string; percent: number; valueUsd?: number | null }[]
}
function readJsonAcceptAssets(value: unknown): VaultAcceptAsset[] | null {
  if (value == null || value === Prisma.DbNull || value === Prisma.JsonNull) return null
  return value as VaultAcceptAsset[]
}

export type PrismaLike = {
  $queryRaw?: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>
  // Real Prisma runs the batched operations in ONE transaction (atomic). Optional so the in-memory
  // test harness can omit it (callers fall back to a sequential Promise.all).
  $transaction?: (operations: unknown[]) => Promise<unknown[]>
  evmNetwork: {
    upsert(args: unknown): Promise<unknown>
    findMany(args?: unknown): Promise<unknown[]>
    findUnique(args: unknown): Promise<unknown | null>
  }
  evmAssetDeployment: {
    upsert(args: unknown): Promise<unknown>
    findMany(args?: unknown): Promise<unknown[]>
  }
  evmProductDeployment: {
    upsert(args: unknown): Promise<unknown>
    findMany(args?: unknown): Promise<unknown[]>
  }
  evmIndexedEvent: {
    upsert(args: unknown): Promise<unknown>
    findMany(args?: unknown): Promise<unknown[]>
  }
  evmIndexerCursor: {
    upsert(args: unknown): Promise<unknown>
    findUnique(args: unknown): Promise<unknown | null>
  }
  indexedRedemptionRequest: {
    upsert(args: unknown): Promise<unknown>
    updateMany(args: unknown): Promise<{ count: number }>
    findMany(args?: unknown): Promise<unknown[]>
    findFirst(args?: unknown): Promise<unknown | null>
  }
  vaultConfig: {
    upsert(args: unknown): Promise<unknown>
    findMany(args?: unknown): Promise<unknown[]>
  }
  featuredCard: {
    findMany(args?: unknown): Promise<unknown[]>
    count(args?: unknown): Promise<number>
    create(args: unknown): Promise<unknown>
    update(args: unknown): Promise<unknown>
    delete(args: unknown): Promise<unknown>
  }
  walletAttestation: {
    create(args: unknown): Promise<unknown>
  }
  authNonce: {
    create(args: unknown): Promise<unknown>
    updateMany(args: unknown): Promise<{ count: number }>
    findUnique(args: unknown): Promise<unknown | null>
  }
}

function normalizeAddress(address: string): string {
  return address.toLowerCase()
}

export type VaultConfigValues = {
  displayName: string | null
  category: string | null
  description: string | null
  adminDepositAddress: string | null
  cardSnapshot: boolean
  cardIndustry: boolean
  cardExposure: boolean
  pinned: boolean
  hidden: boolean
  // "product" (Products) or "saving" (Savings page only). Non-null; literal (not imported from
  // shared) to keep the server dist layout — a drift test guards it against the shared taxonomy.
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
  // "More info" docs links: URL + show toggle per slot. Rendered only when shown AND url != null.
  docsUrl: string | null
  legalUrl: string | null
  risksUrl: string | null
  docsShown: boolean
  legalShown: boolean
  risksShown: boolean
  // Portfolio breakdowns (P3): validated slice arrays or null (fall back).
  portfolioSnapshot: VaultPortfolioSlice[] | null
  portfolioIndustry: VaultPortfolioSlice[] | null
  portfolioExposure: VaultPortfolioSlice[] | null
  // Savings accept-assets (only meaningful for kind="saving"): ordered array or null.
  acceptAssets: VaultAcceptAsset[] | null
}

export type VaultPortfolioSlice = { label: string; percent: number; valueUsd?: number | null }

// A Savings-page accept-asset entry. `order` is the array index; `savingVaultId` is the owning
// saving vault's productId for a real asset, or null for a dummy (coming-soon) asset that maps to
// nothing yet (both set at save, not editable rows). `isDummy` = display-only / coming-soon.
export type VaultAcceptAsset = {
  symbol: string
  icon: string | null
  apy: number | null
  savingVaultId: string | null
  isDummy: boolean
  // Global cross-vault display order for the Savings selector (nullable int ≥0). Distinct from the
  // intra-vault array index; unset (null) sorts after ordered cards. Set via the savings-order route.
  sortOrder: number | null
}

export type FeaturedCardRow = {
  id: string
  productId: string
  about: string | null
  shown: boolean
  position: number
}

// Defaults for products without a config row: visible, not pinned, all card views on,
// and every display-profile field null (legacy fallback). Existing vaults therefore stay
// exactly as they are until an operator saves a config.
export function withVaultConfigDefaults(row?: Partial<VaultConfigValues> | null): VaultConfigValues {
  return {
    displayName: row?.displayName ?? null,
    category: row?.category ?? null,
    description: row?.description ?? null,
    adminDepositAddress: row?.adminDepositAddress ?? null,
    cardSnapshot: row?.cardSnapshot ?? true,
    cardIndustry: row?.cardIndustry ?? true,
    cardExposure: row?.cardExposure ?? true,
    pinned: row?.pinned ?? false,
    hidden: row?.hidden ?? false,
    kind: row?.kind === "saving" ? "saving" : "product",
    assetManagerName: row?.assetManagerName ?? null,
    issuerName: row?.issuerName ?? null,
    about: row?.about ?? null,
    aum: row?.aum ?? null,
    redemptionTimelineDays: row?.redemptionTimelineDays ?? null,
    feeInstantMintingBps: row?.feeInstantMintingBps ?? null,
    feeInstantRedemptionBps: row?.feeInstantRedemptionBps ?? null,
    feeManagementBps: row?.feeManagementBps ?? null,
    feePerformanceBps: row?.feePerformanceBps ?? null,
    vaultImageUrl: row?.vaultImageUrl ?? null,
    assetManagerImageUrl: row?.assetManagerImageUrl ?? null,
    issuerImageUrl: row?.issuerImageUrl ?? null,
    // shown defaults TRUE; the null URL keeps the link invisible until an operator sets one.
    docsUrl: row?.docsUrl ?? null,
    legalUrl: row?.legalUrl ?? null,
    risksUrl: row?.risksUrl ?? null,
    docsShown: row?.docsShown ?? true,
    legalShown: row?.legalShown ?? true,
    risksShown: row?.risksShown ?? true,
    portfolioSnapshot: readJsonSlices(row?.portfolioSnapshot),
    portfolioIndustry: readJsonSlices(row?.portfolioIndustry),
    portfolioExposure: readJsonSlices(row?.portfolioExposure),
    acceptAssets: readJsonAcceptAssets(row?.acceptAssets),
  }
}

function toBigIntOrNull(value: bigint | number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null
  return typeof value === "bigint" ? value : BigInt(value)
}

export class PrismaArcoService {
  constructor(private readonly prisma: PrismaLike) {}

  async healthCheck() {
    if (this.prisma.$queryRaw) {
      await this.prisma.$queryRaw`SELECT 1`
    }
    return { ok: true }
  }

  async syncRegistry(registry: RegistrySyncInput) {
    await this.prisma.evmNetwork.upsert({
      where: { chainId: registry.chainId },
      create: {
        chainId: registry.chainId,
        name: registry.name,
        network: registry.network,
        publicRpcUrl: registry.publicRpcUrl ?? null,
        explorerUrl: registry.explorerUrl ?? null,
        blockscoutApiUrl: registry.blockscoutApiUrl ?? null,
        nativeCurrency: registry.nativeCurrency ?? null,
        latestRegistryId: registry.releaseId,
        registrySyncedAt: new Date(),
      },
      update: {
        name: registry.name,
        network: registry.network,
        publicRpcUrl: registry.publicRpcUrl ?? null,
        explorerUrl: registry.explorerUrl ?? null,
        blockscoutApiUrl: registry.blockscoutApiUrl ?? null,
        nativeCurrency: registry.nativeCurrency ?? null,
        latestRegistryId: registry.releaseId,
        registrySyncedAt: new Date(),
      },
    })

    for (const asset of registry.assets) {
      await this.prisma.evmAssetDeployment.upsert({
        where: { chainId_symbol: { chainId: registry.chainId, symbol: asset.symbol } },
        create: {
          chainId: registry.chainId,
          symbol: asset.symbol,
          name: asset.name,
          decimals: asset.decimals,
          tokenAddress: normalizeAddress(asset.tokenAddress),
          faucetAddress: asset.faucetAddress ? normalizeAddress(asset.faucetAddress) : null,
          deploymentBlock: toBigIntOrNull(asset.deploymentBlock),
          registryReleaseId: registry.releaseId,
          metadata: asset.metadata ?? null,
        },
        update: {
          name: asset.name,
          decimals: asset.decimals,
          tokenAddress: normalizeAddress(asset.tokenAddress),
          faucetAddress: asset.faucetAddress ? normalizeAddress(asset.faucetAddress) : null,
          deploymentBlock: toBigIntOrNull(asset.deploymentBlock),
          registryReleaseId: registry.releaseId,
          metadata: asset.metadata ?? null,
        },
      })
    }

    for (const product of registry.products) {
      await this.prisma.evmProductDeployment.upsert({
        where: { chainId_productId: { chainId: registry.chainId, productId: product.productId } },
        create: {
          chainId: registry.chainId,
          productId: product.productId,
          symbol: product.symbol,
          name: product.name,
          productTokenAddress: normalizeAddress(product.productTokenAddress),
          paymentAssetSymbol: product.paymentAssetSymbol,
          paymentAssetAddress: normalizeAddress(product.paymentAssetAddress),
          depositVaultAddress: normalizeAddress(product.depositVaultAddress),
          redemptionVaultAddress: normalizeAddress(product.redemptionVaultAddress),
          priceFeedAddress: normalizeAddress(product.priceFeedAddress),
          deploymentBlock: toBigIntOrNull(product.deploymentBlock),
          registryReleaseId: registry.releaseId,
          activationFlags: product.activationFlags ?? null,
          metadata: product.metadata ?? null,
        },
        update: {
          symbol: product.symbol,
          name: product.name,
          productTokenAddress: normalizeAddress(product.productTokenAddress),
          paymentAssetSymbol: product.paymentAssetSymbol,
          paymentAssetAddress: normalizeAddress(product.paymentAssetAddress),
          depositVaultAddress: normalizeAddress(product.depositVaultAddress),
          redemptionVaultAddress: normalizeAddress(product.redemptionVaultAddress),
          priceFeedAddress: normalizeAddress(product.priceFeedAddress),
          deploymentBlock: toBigIntOrNull(product.deploymentBlock),
          registryReleaseId: registry.releaseId,
          activationFlags: product.activationFlags ?? null,
          metadata: product.metadata ?? null,
        },
      })
    }
  }

  async listNetworks() {
    return this.prisma.evmNetwork.findMany({ orderBy: { chainId: "asc" } })
  }

  async getRegistry(chainId: number) {
    const network = await this.prisma.evmNetwork.findUnique({ where: { chainId } })
    const assets = await this.prisma.evmAssetDeployment.findMany({ where: { chainId } })
    const products = await this.prisma.evmProductDeployment.findMany({ where: { chainId } })
    return { network, assets, products }
  }

  async insertIndexedEvent(input: IndexedEventInput) {
    return this.prisma.evmIndexedEvent.upsert({
      where: {
        chainId_txHash_logIndex: {
          chainId: input.chainId,
          txHash: input.txHash,
          logIndex: input.logIndex,
        },
      },
      create: {
        ...input,
        contractAddress: normalizeAddress(input.contractAddress),
        blockNumber: toBigIntOrNull(input.blockNumber),
        blockTimestamp: input.blockTimestamp ?? null,
        removed: input.removed ?? false,
      },
      update: {},
    })
  }

  async getIndexerCursor(chainId: number, name: string) {
    return this.prisma.evmIndexerCursor.findUnique({
      where: { chainId_name: { chainId, name } },
    })
  }

  async upsertIndexerCursor(input: IndexerCursorInput) {
    return this.prisma.evmIndexerCursor.upsert({
      where: { chainId_name: { chainId: input.chainId, name: input.name } },
      create: {
        chainId: input.chainId,
        name: input.name,
        fromBlock: toBigIntOrNull(input.fromBlock),
        lastBlock: toBigIntOrNull(input.lastBlock),
        lastBlockHash: input.lastBlockHash ?? null,
        confirmations: input.confirmations,
        lagBlocks: input.lagBlocks,
      },
      update: {
        fromBlock: toBigIntOrNull(input.fromBlock),
        lastBlock: toBigIntOrNull(input.lastBlock),
        lastBlockHash: input.lastBlockHash ?? null,
        confirmations: input.confirmations,
        lagBlocks: input.lagBlocks,
      },
    })
  }

  async upsertRedemptionRequest(input: RedemptionRequestIndexInput) {
    return this.prisma.indexedRedemptionRequest.upsert({
      where: {
        chainId_redemptionVaultAddress_requestId: {
          chainId: input.chainId,
          redemptionVaultAddress: normalizeAddress(input.redemptionVaultAddress),
          requestId: input.requestId,
        },
      },
      create: {
        chainId: input.chainId,
        requestId: input.requestId,
        walletAddress: normalizeAddress(input.walletAddress),
        productId: input.productId,
        productTokenAddress: normalizeAddress(input.productTokenAddress),
        redemptionVaultAddress: normalizeAddress(input.redemptionVaultAddress),
        sharesIn: input.sharesIn,
        lockedAssetsOut: input.lockedAssetsOut,
        status: "REQUESTED",
        requestedTxHash: input.requestedTxHash,
        requestedAtBlock: toBigIntOrNull(input.requestedAtBlock),
        metadata: input.metadata ?? null,
      },
      update: {
        walletAddress: normalizeAddress(input.walletAddress),
        sharesIn: input.sharesIn,
        lockedAssetsOut: input.lockedAssetsOut,
        status: "REQUESTED",
        requestedTxHash: input.requestedTxHash,
        requestedAtBlock: toBigIntOrNull(input.requestedAtBlock),
        metadata: input.metadata ?? null,
      },
    })
  }

  async markRedemptionFulfilled(input: {
    chainId: number
    redemptionVaultAddress: string
    requestId: string
    txHash: string
    now?: Date
  }) {
    return this.prisma.indexedRedemptionRequest.updateMany({
      where: {
        chainId: input.chainId,
        redemptionVaultAddress: normalizeAddress(input.redemptionVaultAddress),
        requestId: input.requestId,
      },
      data: {
        status: "FULFILLED",
        fulfilledTxHash: input.txHash,
        fulfilledAt: input.now ?? new Date(),
      },
    })
  }

  async markRedemptionClaimed(input: {
    chainId: number
    redemptionVaultAddress: string
    requestId: string
    txHash: string
    now?: Date
  }) {
    return this.prisma.indexedRedemptionRequest.updateMany({
      where: {
        chainId: input.chainId,
        redemptionVaultAddress: normalizeAddress(input.redemptionVaultAddress),
        requestId: input.requestId,
      },
      data: {
        status: "CLAIMED",
        claimedTxHash: input.txHash,
        claimedAt: input.now ?? new Date(),
      },
    })
  }

  // Unsettled redemptions for the admin payout console: REQUESTED (awaiting payout) plus
  // SETTLING (payout in flight — kept visible so the operator can finish or inspect it).
  async pendingRedemptions(chainId: number) {
    return this.prisma.indexedRedemptionRequest.findMany({
      where: {
        chainId,
        status: { in: ["REQUESTED", "SETTLING"] },
      },
      orderBy: { createdAt: "asc" },
    })
  }

  // Atomically claims a request for payout (REQUESTED -> SETTLING). Returns the number of
  // rows transitioned: 0 means the request was already settling/settled — the caller must
  // treat that as a conflict so the same request can never be paid twice.
  async markRedemptionSettling(input: { chainId: number; requestId: string }) {
    return this.prisma.indexedRedemptionRequest.updateMany({
      where: {
        chainId: input.chainId,
        requestId: input.requestId,
        status: "REQUESTED",
      },
      data: {
        status: "SETTLING",
      },
    })
  }

  // Cancelled/failed payout recovery: SETTLING -> REQUESTED only. Never touches SETTLED rows,
  // so a request whose payout actually landed on-chain cannot be re-opened for double pay.
  async markRedemptionReleased(input: { chainId: number; requestId: string }) {
    return this.prisma.indexedRedemptionRequest.updateMany({
      where: {
        chainId: input.chainId,
        requestId: input.requestId,
        status: "SETTLING",
      },
      data: {
        status: "REQUESTED",
      },
    })
  }

  // Direct-transfer payout confirmed on-chain: SETTLING/REQUESTED -> SETTLED with the payout
  // tx hash. (REQUESTED is accepted so a settle after an out-of-band payout still lands.)
  async markRedemptionSettled(input: { chainId: number; requestId: string; txHash: string; now?: Date }) {
    return this.prisma.indexedRedemptionRequest.updateMany({
      where: {
        chainId: input.chainId,
        requestId: input.requestId,
        status: { in: ["REQUESTED", "SETTLING"] },
      },
      data: {
        status: "SETTLED",
        settledTxHash: input.txHash,
        settledAt: input.now ?? new Date(),
      },
    })
  }

  async activityForWallet(walletAddress: string, chainId?: number) {
    const normalized = normalizeAddress(walletAddress)
    return this.prisma.evmIndexedEvent.findMany({
      where: {
        ...(chainId ? { chainId } : {}),
        args: { path: ["walletAddress"], equals: normalized },
      },
      orderBy: [{ blockNumber: "desc" }, { logIndex: "desc" }],
    })
  }

  async priceUpdatesForFeed(chainId: number, feedAddress: string) {
    return this.prisma.evmIndexedEvent.findMany({
      where: {
        chainId,
        eventName: "PriceUpdated",
        contractAddress: normalizeAddress(feedAddress),
      },
      orderBy: [{ blockNumber: "asc" }, { logIndex: "asc" }],
    })
  }

  // Targeted registry sync for 2c "register deployed vault": upserts ONE product row
  // (same shape as syncRegistry) so the DB registry picks up a newly deployed product
  // without a full re-sync. The registry FILE (deploy-harness output) stays the source
  // of truth; callers validate against it first.
  async upsertProductDeployment(chainId: number, releaseId: string, product: RegistrySyncInput["products"][number]) {
    return this.prisma.evmProductDeployment.upsert({
      where: { chainId_productId: { chainId, productId: product.productId } },
      create: {
        chainId,
        productId: product.productId,
        symbol: product.symbol,
        name: product.name,
        productTokenAddress: normalizeAddress(product.productTokenAddress),
        paymentAssetSymbol: product.paymentAssetSymbol,
        paymentAssetAddress: normalizeAddress(product.paymentAssetAddress),
        depositVaultAddress: normalizeAddress(product.depositVaultAddress),
        redemptionVaultAddress: normalizeAddress(product.redemptionVaultAddress),
        priceFeedAddress: normalizeAddress(product.priceFeedAddress),
        deploymentBlock: toBigIntOrNull(product.deploymentBlock),
        registryReleaseId: releaseId,
        activationFlags: product.activationFlags ?? null,
        metadata: product.metadata ?? null,
      },
      update: {
        symbol: product.symbol,
        name: product.name,
        productTokenAddress: normalizeAddress(product.productTokenAddress),
        paymentAssetSymbol: product.paymentAssetSymbol,
        paymentAssetAddress: normalizeAddress(product.paymentAssetAddress),
        depositVaultAddress: normalizeAddress(product.depositVaultAddress),
        redemptionVaultAddress: normalizeAddress(product.redemptionVaultAddress),
        priceFeedAddress: normalizeAddress(product.priceFeedAddress),
        deploymentBlock: toBigIntOrNull(product.deploymentBlock),
        registryReleaseId: releaseId,
        activationFlags: product.activationFlags ?? null,
        metadata: product.metadata ?? null,
      },
    })
  }

  // Off-chain per-vault display config (admin-ia-plan §2). No row => defaults via
  // withVaultConfigDefaults (visible, not pinned, all card views on).
  async vaultConfigs(chainId: number) {
    return this.prisma.vaultConfig.findMany({ where: { chainId } })
  }

  async upsertVaultConfig(
    input: { chainId: number; productId: string } & Partial<VaultConfigValues>,
  ) {
    const { chainId, productId, portfolioSnapshot, portfolioIndustry, portfolioExposure, acceptAssets, ...fields } = input
    const json: Record<string, unknown> = { ...fields }
    // Only touch a Json column when the caller provided it; map null -> DbNull.
    if (portfolioSnapshot !== undefined) json.portfolioSnapshot = jsonNullableWrite(portfolioSnapshot)
    if (portfolioIndustry !== undefined) json.portfolioIndustry = jsonNullableWrite(portfolioIndustry)
    if (portfolioExposure !== undefined) json.portfolioExposure = jsonNullableWrite(portfolioExposure)
    if (acceptAssets !== undefined) json.acceptAssets = jsonNullableWrite(acceptAssets)
    return this.prisma.vaultConfig.upsert({
      where: { chainId_productId: { chainId, productId } },
      create: { chainId, productId, ...json },
      update: json,
    })
  }

  // Atomically rewrite the acceptAssets JSON of several saving vaults in ONE transaction — used by
  // the savings-order route so a cross-vault reorder can never land half-applied. Each update
  // carries the vault's FULL acceptAssets array (only sortOrder changed by the caller), so no other
  // field is touched. Real Prisma batches via $transaction; the harness falls back to Promise.all.
  async setSavingsOrder(
    chainId: number,
    updates: Array<{ productId: string; acceptAssets: VaultAcceptAsset[] | null }>,
  ) {
    const operations = updates.map((update) =>
      this.prisma.vaultConfig.upsert({
        where: { chainId_productId: { chainId, productId: update.productId } },
        create: { chainId, productId: update.productId, acceptAssets: jsonNullableWrite(update.acceptAssets) },
        update: { acceptAssets: jsonNullableWrite(update.acceptAssets) },
      }),
    )
    if (this.prisma.$transaction) return this.prisma.$transaction(operations)
    return Promise.all(operations)
  }

  // Products-page hero carousel selection. Ordered by position (JS-sorted so the order
  // holds even when the caller's findMany ignores orderBy — the in-memory test harness does).
  async featuredCards(chainId: number) {
    const rows = (await this.prisma.featuredCard.findMany({
      where: { chainId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    })) as FeaturedCardRow[]
    return [...rows].sort((a, b) => a.position - b.position)
  }

  async countFeaturedCards(chainId: number) {
    return this.prisma.featuredCard.count({ where: { chainId } })
  }

  async createFeaturedCard(input: {
    chainId: number
    productId: string
    about: string | null
    shown: boolean
    position: number
  }) {
    return this.prisma.featuredCard.create({ data: input }) as Promise<FeaturedCardRow>
  }

  async updateFeaturedCard(id: string, patch: Partial<{ about: string | null; shown: boolean; position: number }>) {
    return this.prisma.featuredCard.update({ where: { id }, data: patch }) as Promise<FeaturedCardRow>
  }

  async deleteFeaturedCard(id: string) {
    return this.prisma.featuredCard.delete({ where: { id } })
  }

  // Read-only monitoring query: raw indexed rows for on-the-fly aggregation, ordered by
  // chain position. Callers map contract addresses back to products via the registry.
  async indexedEventsForContracts(chainId: number, contractAddresses: string[], eventNames: string[]) {
    return this.prisma.evmIndexedEvent.findMany({
      where: {
        chainId,
        eventName: { in: eventNames },
        contractAddress: { in: contractAddresses.map(normalizeAddress) },
      },
      orderBy: [{ blockNumber: "asc" }, { logIndex: "asc" }],
    })
  }

  // Read-only monitoring query: every redemption request (any status) for pending-over-time
  // trends and requester lists; optionally scoped to one product.
  async redemptionRequestsForChain(chainId: number, productId?: string) {
    return this.prisma.indexedRedemptionRequest.findMany({
      where: {
        chainId,
        ...(productId ? { productId } : {}),
      },
      orderBy: { createdAt: "asc" },
    })
  }

  async redemptionsForWallet(walletAddress: string, chainId?: number) {
    return this.prisma.indexedRedemptionRequest.findMany({
      where: {
        walletAddress: normalizeAddress(walletAddress),
        ...(chainId ? { chainId } : {}),
      },
      orderBy: { createdAt: "desc" },
    })
  }

  async findRedemptionRequest(chainId: number, requestId: string) {
    return this.prisma.indexedRedemptionRequest.findFirst({
      where: {
        chainId,
        requestId,
      },
      orderBy: { createdAt: "desc" },
    })
  }

  async issueAuthNonce(input: AuthNonceInput) {
    const now = input.now ?? new Date()
    return this.prisma.authNonce.create({
      data: {
        walletAddress: normalizeAddress(input.walletAddress),
        domain: input.domain,
        nonce: input.nonce,
        expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000),
        consumedAt: null,
      },
    })
  }

  async consumeAuthNonce(input: ConsumeNonceInput) {
    const now = input.now ?? new Date()
    const nonce = input.nonce
    const result = await this.prisma.authNonce.updateMany({
      where: {
        walletAddress: normalizeAddress(input.walletAddress),
        domain: input.domain,
        nonce,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    })
    if (result.count !== 1) return null
    return this.prisma.authNonce.findUnique({ where: { nonce } })
  }

  async createWalletAttestation(input: WalletAttestationInput) {
    return this.prisma.walletAttestation.create({
      data: {
        walletAddress: normalizeAddress(input.walletAddress),
        domain: input.domain,
        statement: input.statement ?? null,
        signature: input.signature,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt ?? null,
      },
    })
  }

  async faucetStatus(walletAddress: string, chainId: number): Promise<FaucetStatus> {
    return {
      walletAddress: normalizeAddress(walletAddress),
      chainId,
      available: true,
      reason: null,
    }
  }
}

import { formatUnits } from "viem"
import type { ArcoUSDChainReader, AssetState, ReserveState } from "../arcousd/reader.js"
import { apyForProduct } from "../registry/apy.js"
import type { OunceUsdSource } from "../services/usd-rates.js"
import { deployedArcoGold, goldReserveDeployment, type ArcoGoldRegistryFile, type DeployedArcoGold } from "./registry.js"
import type { GoldVaultReader, GoldVaultState } from "./vault.js"

// Public ArcoGOLD state: the gold Reserve (per-coin instant liquidity, totals, pauses) and the ArcoGOLD vault (price per
// share, totals, pauses), with the USD value of one troy ounce. Read-only and never a 500: "not-deployed" while the
// registry file is absent (or the deploy script has not finished), "unavailable" when the file is invalid or a chain
// read fails. Each answer is cached briefly so a page load's fan-out costs one RPC sweep.

export const ARCOGOLD_PRODUCT_ID = "arcogold"
/** Where the ounce price comes from (server/src/services/usd-rates.ts): PAX Gold, one token per fine troy ounce.
 * The primary source, reported unless the price came from the fallback ("kraken:paxg") or the source is not given. */
export const OUNCE_USD_SOURCE = "coingecko:pax-gold" satisfies OunceUsdSource

export type GoldStatus = "not-deployed" | "live" | "unavailable"

/** The gold Reserve: what the ArcoUSD reader reads, in ounces (base18) instead of dollars; no Router, no strategies. */
export type GoldReserveState = Omit<ReserveState, "totalBackingUsd" | "totalLiabilitiesUsd" | "routerPaused" | "strategies"> & {
  readonly totalBackingOunces: string
  readonly totalLiabilitiesOunces: string
  readonly assets: readonly AssetState[]
}

export type GoldReserveResponse = {
  readonly status: GoldStatus
  readonly chainId: number
  readonly contracts: null | { readonly unit: string; readonly reserve: string; readonly lens: string }
  readonly readAt: string
  readonly reserve: GoldReserveState | null
}

export type GoldSavingsContracts = {
  readonly arcoGOLD: string
  readonly zap: string
  readonly unit: string
  readonly reserve: string
}

export type GoldSavingsResponse = {
  readonly status: GoldStatus
  readonly chainId: number
  readonly contracts: GoldSavingsContracts | null
  readonly readAt: string
  readonly savings: GoldVaultState | null
  /** The set display rate (server/src/registry/apy.ts), in percent; null when none is set. */
  readonly apyPercent: number | null
  /** USD per troy ounce, or null while the rate source cannot answer (never a guessed price). */
  readonly ounceUsd: number | null
  readonly ounceUsdSource: OunceUsdSource
  /** USD per ArcoGOLD (share price × ounce price); null without either. */
  readonly sharePriceUsd: number | null
  /** The vault's ounces in USD (decimal string); null without the ounce price. */
  readonly totalAssetsUsd: string | null
}

type Cached<T> = { at: number; value: T } | null

export class ArcoGoldService {
  private reserveCache: Cached<GoldReserveResponse> = null
  private savingsCache: Cached<GoldSavingsResponse> = null
  private reserveInflight: Promise<GoldReserveResponse> | null = null
  private savingsInflight: Promise<GoldSavingsResponse> | null = null

  constructor(
    private readonly deps: {
      readonly chainId: number
      readonly loadRegistry: () => ArcoGoldRegistryFile | null
      readonly readReserve?: ArcoUSDChainReader
      readonly readVault?: GoldVaultReader
      /** USD per troy ounce (optionally with its actual source), null when unknown. */
      readonly ounceUsd?: () => Promise<number | { readonly usd: number; readonly source: OunceUsdSource } | null>
      readonly now?: () => number
      /** Default 15s, like the ArcoUSD reads. */
      readonly cacheMs?: number
    },
  ) {}

  async reserveState(): Promise<GoldReserveResponse> {
    const now = this.now()
    if (this.reserveCache && now - this.reserveCache.at < this.cacheMs()) return this.reserveCache.value
    if (!this.reserveInflight) this.reserveInflight = this.loadReserve().finally(() => (this.reserveInflight = null))
    const value = await this.reserveInflight
    this.reserveCache = { at: this.now(), value }
    return value
  }

  async savingsState(): Promise<GoldSavingsResponse> {
    const now = this.now()
    if (this.savingsCache && now - this.savingsCache.at < this.cacheMs()) return this.savingsCache.value
    if (!this.savingsInflight) this.savingsInflight = this.loadSavings().finally(() => (this.savingsInflight = null))
    const value = await this.savingsInflight
    this.savingsCache = { at: this.now(), value }
    return value
  }

  private cacheMs() {
    return this.deps.cacheMs ?? 15_000
  }

  private now() {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private deployment(): { status: "live"; gold: DeployedArcoGold } | { status: "not-deployed" | "unavailable" } {
    try {
      const gold = deployedArcoGold(this.deps.loadRegistry(), this.deps.chainId)
      return gold ? { status: "live", gold } : { status: "not-deployed" }
    } catch {
      // A present-but-invalid (or unreadable) registry is an ops error: answered as unavailable, never thrown.
      return { status: "unavailable" }
    }
  }

  private async loadReserve(): Promise<GoldReserveResponse> {
    const base = { chainId: this.deps.chainId, readAt: new Date(this.now()).toISOString() }
    const current = this.deployment()
    if (current.status !== "live") return { ...base, status: current.status, contracts: null, reserve: null }
    const { gold } = current
    const contracts = { unit: gold.unitAddress.toLowerCase(), reserve: gold.reserveAddress.toLowerCase(), lens: gold.lensAddress.toLowerCase() }
    if (!this.deps.readReserve) return { ...base, status: "unavailable", contracts, reserve: null }
    try {
      const state = await this.deps.readReserve(goldReserveDeployment(gold))
      return { ...base, status: "live", contracts, reserve: toGoldReserveState(state) }
    } catch {
      return { ...base, status: "unavailable", contracts, reserve: null }
    }
  }

  private async loadSavings(): Promise<GoldSavingsResponse> {
    const empty = {
      chainId: this.deps.chainId,
      readAt: new Date(this.now()).toISOString(),
      apyPercent: apyForProduct(ARCOGOLD_PRODUCT_ID),
      ounceUsd: null,
      ounceUsdSource: OUNCE_USD_SOURCE as OunceUsdSource,
      sharePriceUsd: null,
      totalAssetsUsd: null,
    } as const
    const current = this.deployment()
    if (current.status !== "live") return { ...empty, status: current.status, contracts: null, savings: null }
    const { gold } = current
    const contracts: GoldSavingsContracts = {
      arcoGOLD: gold.vaultAddress.toLowerCase(),
      zap: gold.zapAddress.toLowerCase(),
      unit: gold.unitAddress.toLowerCase(),
      reserve: gold.reserveAddress.toLowerCase(),
    }
    if (!this.deps.readVault) return { ...empty, status: "unavailable", contracts, savings: null }
    let savings: GoldVaultState
    try {
      savings = await this.deps.readVault(gold)
    } catch {
      return { ...empty, status: "unavailable", contracts, savings: null }
    }
    // The ounce price is best-effort: without it the vault still answers (amounts in ounces), its USD fields null.
    let ounceUsd: number | null = null
    let ounceUsdSource: OunceUsdSource = OUNCE_USD_SOURCE
    try {
      const quote = this.deps.ounceUsd ? await this.deps.ounceUsd() : null
      const price = quote !== null && typeof quote === "object" ? quote.usd : quote
      ounceUsd = typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null
      if (ounceUsd !== null && quote !== null && typeof quote === "object") ounceUsdSource = quote.source
    } catch {
      ounceUsd = null
    }
    const sharePrice = Number(savings.sharePriceHuman)
    return {
      ...empty,
      status: "live",
      contracts,
      savings,
      ounceUsd,
      ounceUsdSource,
      sharePriceUsd: ounceUsd !== null && Number.isFinite(sharePrice) ? sharePrice * ounceUsd : null,
      totalAssetsUsd: ounceUsd !== null ? String(Number(formatUnits(BigInt(savings.totalAssets), 18)) * ounceUsd) : null,
    }
  }
}

export function toGoldReserveState(state: ReserveState): GoldReserveState {
  const { totalBackingUsd: _backing, totalLiabilitiesUsd: _liabilities, routerPaused: _router, strategies: _strategies, ...rest } = state
  return {
    ...rest,
    totalBackingOunces: formatUnits(BigInt(state.totalBacking), 18),
    totalLiabilitiesOunces: formatUnits(BigInt(state.totalLiabilities), 18),
  }
}

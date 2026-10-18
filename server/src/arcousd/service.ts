import { parseUnits } from "viem"
import { gateConfigInvalid, type ArcoUSDEnv } from "./config.js"
import type { ArcoUSDChainReader, ReserveState } from "./reader.js"
import { deployedArcoUSD, type ArcoUSDRegistryFile, type DeployedArcoUSD } from "./registry.js"

// Public ArcoUSD reserve state + the product "buy gate". The gate is the screen-side half of
// the rule "when the USDC buffer is short, block every fund buy button"; the on-chain half is
// ArcoUSDReserve.settleFor reverting with InsufficientLiquidity. It also closes on anything else
// that makes a Router buy revert: the pauses on its path and a full mint cap (a stablecoin-paid
// buy mints ArcoUSD before settling). Fails CLOSED once ArcoUSD is
// deployed: an unreadable reserve disables buys rather than letting them fail on-chain.

export type BuyGate = {
  /** inactive: ArcoUSD not deployed — buys do not settle through the Reserve yet. */
  readonly status: "inactive" | "open" | "closed"
  readonly reason:
    | null
    | "not-deployed"
    | "read-failed"
    | "settlement-paused"
    | "buy-paused"
    | "mint-cap"
    | "insufficient-buffer"
    | "asset-missing"
    | "config-invalid"
  readonly asset: string
  readonly available: string | null
  readonly threshold: string
  readonly checkedAt: string
}

export type ReserveStateResponse = {
  readonly status: "not-deployed" | "live" | "unavailable"
  readonly chainId: number
  readonly contracts: null | {
    readonly arcoUSD: string
    readonly reserve: string
    readonly lens: string
    /** null until the Router is deployed. */
    readonly router: string | null
    /** Products the Router can buy (fund buys paid in any Reserve stablecoin). */
    readonly routerProducts: readonly string[]
  }
  readonly readAt: string
  readonly reserve: ReserveState | null
  readonly gate: BuyGate
}

export class ArcoUSDService {
  private cache: { at: number; value: ReserveStateResponse } | null = null
  private inflight: Promise<ReserveStateResponse> | null = null

  constructor(
    private readonly deps: {
      readonly chainId: number
      readonly env: ArcoUSDEnv
      readonly loadRegistry: () => ArcoUSDRegistryFile | null
      readonly read?: ArcoUSDChainReader
      readonly now?: () => number
      /** Default 15s: a page load fans out to many components; one RPC sweep serves them. */
      readonly cacheMs?: number
    },
  ) {}

  async reserveState(): Promise<ReserveStateResponse> {
    const now = this.now()
    if (this.cache && now - this.cache.at < (this.deps.cacheMs ?? 15_000)) return this.cache.value
    if (!this.inflight) {
      this.inflight = this.load().finally(() => {
        this.inflight = null
      })
    }
    const value = await this.inflight
    this.cache = { at: this.now(), value }
    return value
  }

  async gate(): Promise<BuyGate> {
    return (await this.reserveState()).gate
  }

  private now() {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private async load(): Promise<ReserveStateResponse> {
    const readAt = new Date(this.now()).toISOString()
    let deployment: DeployedArcoUSD | null
    try {
      deployment = deployedArcoUSD(this.deps.loadRegistry(), this.deps.chainId)
    } catch {
      // A present-but-invalid registry is an ops error: treat it like an unreadable reserve.
      return this.unavailable(readAt, null)
    }
    if (!deployment) {
      return {
        status: "not-deployed",
        chainId: this.deps.chainId,
        contracts: null,
        readAt,
        reserve: null,
        gate: this.gateFor(readAt, "inactive", "not-deployed", null),
      }
    }
    const contracts = {
      arcoUSD: deployment.arcoUSDAddress.toLowerCase(),
      reserve: deployment.reserveAddress.toLowerCase(),
      lens: deployment.lensAddress.toLowerCase(),
      router: deployment.routerAddress?.toLowerCase() ?? null,
      routerProducts: deployment.routerProducts,
    }
    if (!this.deps.read) return this.unavailable(readAt, contracts)
    let reserve: ReserveState
    try {
      reserve = await this.deps.read(deployment)
    } catch {
      return this.unavailable(readAt, contracts)
    }
    return { status: "live", chainId: this.deps.chainId, contracts, readAt, reserve, gate: this.evaluateGate(readAt, reserve) }
  }

  private unavailable(readAt: string, contracts: ReserveStateResponse["contracts"]): ReserveStateResponse {
    return {
      status: "unavailable",
      chainId: this.deps.chainId,
      contracts,
      readAt,
      reserve: null,
      gate: this.gateFor(readAt, "closed", "read-failed", null),
    }
  }

  private evaluateGate(readAt: string, reserve: ReserveState): BuyGate {
    if (gateConfigInvalid(this.deps.env)) return this.gateFor(readAt, "closed", "config-invalid", null)
    // settleFor needs the Reserve (paused / fnPaused(settleFor)) AND ArcoUSD.burn (paused /
    // fnPaused(burn)): any of the four makes every product buy revert on-chain.
    if (reserve.reservePaused || reserve.settlementPaused || reserve.arcoUSDPaused || reserve.arcoUSDBurnPaused) {
      return this.gateFor(readAt, "closed", "settlement-paused", null)
    }
    // The Router's own pause, and the deposit/mint a stablecoin-paid buy goes through first.
    if (reserve.routerPaused || reserve.depositPaused || reserve.arcoUSDMintPaused) {
      return this.gateFor(readAt, "closed", "buy-paused", null)
    }
    // Room left under mintCap (liabilities = ArcoUSD supply) must fit a buy of the threshold size.
    if (BigInt(reserve.mintCap) - BigInt(reserve.totalLiabilities) < parseUnits(this.deps.env.buyGateMin, 18)) {
      return this.gateFor(readAt, "closed", "mint-cap", null)
    }
    const asset = reserve.assets.find((item) => item.symbol === this.deps.env.buyGateAsset)
    if (!asset) return this.gateFor(readAt, "closed", "asset-missing", null)
    const threshold = parseUnits(this.deps.env.buyGateMin, asset.decimals)
    const open = BigInt(asset.available) >= threshold
    return this.gateFor(readAt, open ? "open" : "closed", open ? null : "insufficient-buffer", asset.availableHuman)
  }

  private gateFor(
    checkedAt: string,
    status: BuyGate["status"],
    reason: BuyGate["reason"],
    available: string | null,
  ): BuyGate {
    return {
      status,
      reason,
      asset: this.deps.env.buyGateAsset,
      available,
      threshold: this.deps.env.buyGateMin,
      checkedAt,
    }
  }
}

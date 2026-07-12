import type { PublicClient } from "viem"
import { GIWA_CHAIN_ID } from "../registry/products.js"
import { readRegistryFile } from "../registry/io.js"
import { validateGiwaRegistry } from "../registry/validation.js"
import type { PrismaArcoService } from "../services/prisma-arco-service.js"

export type ReadinessCheck = {
  readonly ok: boolean
  readonly checks: Record<string, { ok: boolean; detail?: unknown }>
}

const INFRA_ERROR_DETAIL = {
  db: "db unreachable",
  rpc: "rpc unreachable",
  registry: "registry unavailable",
  indexer: "indexer cursor unavailable",
} as const

export class GiwaReadinessChecker {
  constructor(
    private readonly options: {
      readonly arco: PrismaArcoService
      readonly rpcClient: Pick<PublicClient, "getChainId" | "getBytecode">
      readonly registryPath: string
      readonly cursorName: string
      readonly maxLagBlocks: number
    },
  ) {}

  async check(): Promise<ReadinessCheck> {
    const checks: Record<string, { ok: boolean; detail?: unknown }> = {}

    try {
      await this.options.arco.healthCheck()
      checks.db = { ok: true }
    } catch {
      checks.db = { ok: false, detail: INFRA_ERROR_DETAIL.db }
    }

    try {
      const chainId = await this.options.rpcClient.getChainId()
      checks.rpc = { ok: chainId === GIWA_CHAIN_ID, detail: { chainId } }
    } catch {
      checks.rpc = { ok: false, detail: INFRA_ERROR_DETAIL.rpc }
    }

    try {
      const registry = readRegistryFile(this.options.registryPath)
      const validation = validateGiwaRegistry(registry)
      checks.registry = {
        ok: validation.ok,
        detail: { warnings: validation.warnings, eventMismatches: validation.eventMismatches },
      }

      if (registry.activationFlags.deployed) {
        const addresses = [
          registry.faucet.proxy,
          ...registry.assets.map((asset) => asset.contract.proxy),
          ...registry.products.flatMap((product) => [
            product.productToken.proxy,
            product.depositVault.proxy,
            product.redemptionVault.proxy,
            product.priceFeed.proxy,
          ]),
        ].filter((address): address is `0x${string}` => typeof address === "string")
        const missing: string[] = []
        for (const address of addresses) {
          const bytecode = await this.options.rpcClient.getBytecode({ address })
          if (!bytecode || bytecode === "0x") missing.push(address)
        }
        checks.bytecode = { ok: missing.length === 0, detail: { missing } }
      } else {
        checks.bytecode = { ok: true, detail: "skipped; registry is not-yet-deployed" }
      }
    } catch {
      checks.registry = { ok: false, detail: INFRA_ERROR_DETAIL.registry }
    }

    try {
      const cursor = (await this.options.arco.getIndexerCursor(GIWA_CHAIN_ID, this.options.cursorName)) as
        | { lagBlocks?: number }
        | null
      const lagBlocks = cursor?.lagBlocks ?? Number.POSITIVE_INFINITY
      checks.indexer = {
        ok: lagBlocks <= this.options.maxLagBlocks,
        detail: cursor ? { lagBlocks } : "cursor not found",
      }
    } catch {
      checks.indexer = { ok: false, detail: INFRA_ERROR_DETAIL.indexer }
    }

    return {
      ok: Object.values(checks).every((check) => check.ok),
      checks,
    }
  }
}

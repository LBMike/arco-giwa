import { existsSync, readFileSync } from "fs"
import { loadRegistry } from "../deploy-registry"
import { mergeActiveProducts, registryExtraProducts } from "../deploy-plan"
import type { Address } from "./arcousd-registry"
import type { CoreRefs } from "./deploy-steps"

/**
 * What the ArcoUSD deploy needs from the core GIWA registry (deployments/91342/arco-giwa-preprod.json):
 * tUSDC, the faucet and every deployed product's vaults. Extra products deployed later through
 * GIWA_EXTRA_PRODUCTS (bEQTY …) exist only in the registry file, so they are read from it first and
 * passed in, exactly as deploy-giwa.ts does; otherwise normalizeRegistry replays their deployment
 * records against the built-in product list and throws "Unknown product".
 */
export function loadCoreRefs(registryPath: string, admin: Address, repoRoot: string): CoreRefs {
  const raw = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, "utf8")) : {}
  const products = mergeActiveProducts(registryExtraProducts(raw), [])
  const registry = loadRegistry(registryPath, admin, repoRoot, "cancun", products)
  const usdc = registry.assets.find((asset) => asset.symbol === "tUSDC")
  if (!usdc?.contract.proxy) throw new Error("Core registry has no tUSDC proxy")
  if (!registry.faucet.proxy) throw new Error("Core registry has no faucet proxy")
  const refs: CoreRefs["products"] = {}
  for (const product of registry.products) {
    if (!product.depositVault.proxy || !product.redemptionVault.proxy || !product.productToken.proxy) continue
    refs[product.productId] = {
      depositVault: product.depositVault.proxy,
      redemptionVault: product.redemptionVault.proxy,
      productToken: product.productToken.proxy,
    }
  }
  return {
    admin,
    faucet: registry.faucet.proxy,
    assets: { tUSDC: { address: usdc.contract.proxy, decimals: usdc.decimals } },
    products: refs,
  }
}

import type { GiwaDeploymentRegistry, RegistryProduct } from "../registry/types.js"

export function registryIndexedAddresses(registry: GiwaDeploymentRegistry): `0x${string}`[] {
  const addresses = [
    registry.faucet.proxy,
    ...registry.products.flatMap((product) => productIndexedAddresses(product)),
  ]
  return addresses.filter((address): address is `0x${string}` => typeof address === "string")
}

// The four indexed proxy addresses of a SINGLE product (token, deposit/redemption vaults, price
// feed) — used to scope a gap-backfill getLogs to a newly-registered vault.
export function productIndexedAddresses(product: RegistryProduct): `0x${string}`[] {
  return [
    product.productToken.proxy,
    product.depositVault.proxy,
    product.redemptionVault.proxy,
    product.priceFeed.proxy,
  ].filter((address): address is `0x${string}` => typeof address === "string")
}

export function productForVault(registry: GiwaDeploymentRegistry, vaultAddress: string) {
  const normalized = vaultAddress.toLowerCase()
  return registry.products.find((product) => product.redemptionVault.proxy?.toLowerCase() === normalized) ?? null
}

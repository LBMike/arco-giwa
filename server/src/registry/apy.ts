// Per-product APY (annual %), centralized so it is easy to extend later. RegistryProduct
// has no apy field, so the published rate lives here. Products not listed have no APY (null).
//
// A rate listed here is the one shown everywhere (the market's `apy` leads its `impliedApy`), whatever the price feed
// last did. That is why the Crypto Native savings vaults are listed: their rates are set figures (aBTC 2.79%, aXRP
// 4.57%), not read off the gap between their last two price posts, which swings wildly when a price is corrected
// minutes after a wrong post. Testnet display figures: the vaults' prices do not rise at these rates.
export const APY_BY_PRODUCT: Record<string, number> = {
  acapix: 11.58,
  abtc: 2.79,
  axrp: 4.57,
}

export function apyForProduct(productId: string): number | null {
  return APY_BY_PRODUCT[productId] ?? null
}

// Per-product APY (annual %), centralized so it is easy to extend later. RegistryProduct
// has no apy field, so the published rate lives here. Products not listed have no APY (null).
//
// A rate listed here is the one shown everywhere (the market's `apy` leads its `impliedApy`), whatever the price feed
// last did. That is why aBTC is listed: its rate is a set figure (2.79%), not read off the gap between its last two
// price posts, which swings wildly when a price is corrected minutes after a wrong post.
export const APY_BY_PRODUCT: Record<string, number> = {
  acapix: 11.58,
  abtc: 2.79,
}

export function apyForProduct(productId: string): number | null {
  return APY_BY_PRODUCT[productId] ?? null
}

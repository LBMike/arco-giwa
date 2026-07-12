// Per-product APY (annual %), centralized so it is easy to extend later. RegistryProduct
// has no apy field, so the published rate lives here. Products not listed have no APY (null).
export const APY_BY_PRODUCT: Record<string, number> = {
  acapix: 11.58,
}

export function apyForProduct(productId: string): number | null {
  return APY_BY_PRODUCT[productId] ?? null
}

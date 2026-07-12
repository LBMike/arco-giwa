import type { GiwaCatalogItem, HexAddress } from "./types"

export type ProductOperation =
  | "deposit"
  | "requestDeposit"
  | "redeemInstant"
  | "requestRedeem"
  | "claimRedeem"

export function vaultAddressForOperation(
  product: Pick<GiwaCatalogItem, "depositVaultAddress" | "redemptionVaultAddress">,
  operation: ProductOperation,
): HexAddress | null {
  if (operation === "deposit" || operation === "requestDeposit") {
    return product.depositVaultAddress
  }
  return product.redemptionVaultAddress
}

export function operationLabel(operation: ProductOperation) {
  switch (operation) {
    case "deposit":
      return "Deposit"
    case "requestDeposit":
      return "Request deposit"
    case "redeemInstant":
      return "Redeem instant"
    case "requestRedeem":
      return "Request redemption"
    case "claimRedeem":
      return "Claim redemption"
  }
}

export function requiredPaymentInvariant(product: Pick<GiwaCatalogItem, "symbol" | "paymentAssetSymbol">) {
  return `${product.symbol} accepts ${product.paymentAssetSymbol} only`
}

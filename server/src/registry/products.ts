export const GIWA_CHAIN_ID = 91342
export const GIWA_NETWORK = "giwa-sepolia"
export const GIWA_NAME = "GIWA Sepolia"
export const GIWA_PUBLIC_RPC_URL = "https://sepolia-rpc.giwa.io"
export const GIWA_EXPLORER_BASE_URL = "https://sepolia-explorer.giwa.io"
export const GIWA_BLOCKSCOUT_API_URL = "https://sepolia-explorer.giwa.io/api"

export const REQUIRED_PAYMENT_ASSETS = [
  { symbol: "tUSDC", name: "Test USDC", decimals: 6 },
  { symbol: "tBTC", name: "Test BTC", decimals: 8 },
  { symbol: "tXRP", name: "Test XRP", decimals: 6 },
  { symbol: "tWETH", name: "Test WETH", decimals: 18 },
] as const

export const REQUIRED_PRODUCTS = [
  { productId: "acapix", symbol: "aCAPIX", name: "Arco CAPIX", paymentAssetSymbol: "tUSDC" },
  { productId: "ibenji", symbol: "iBENJI", name: "Arco BENJI", paymentAssetSymbol: "tUSDC" },
  { productId: "umint", symbol: "uMINT", name: "Arco MINT", paymentAssetSymbol: "tUSDC" },
  { productId: "abtc", symbol: "aBTC", name: "Arco BTC", paymentAssetSymbol: "tBTC" },
  { productId: "axrp", symbol: "aXRP", name: "Arco XRP", paymentAssetSymbol: "tXRP" },
  { productId: "aeth", symbol: "aETH", name: "Arco ETH", paymentAssetSymbol: "tWETH" },
] as const

export const REQUIRED_PRODUCT_PAYMENT_MAPPINGS: Record<string, string> =
  Object.fromEntries(REQUIRED_PRODUCTS.map((product) => [product.symbol, product.paymentAssetSymbol]))

export const PLAN_TARGET_INDEXED_EVENTS = [
  "FaucetDrip",
  "ProductDeposit",
  "ProductRedeemInstant",
  "ProductRedeemRequested",
  "ProductRedeemFulfilled",
  "ProductRedeemClaimed",
  "PriceUpdated",
  "Paused",
  "Unpaused",
] as const

export const RESOLVED_INDEXED_EVENTS = [
  ...PLAN_TARGET_INDEXED_EVENTS,
  "ProductDepositRequested",
  "ProductDepositFulfilled",
] as const

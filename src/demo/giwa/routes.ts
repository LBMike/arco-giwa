export const GIWA_PREPROD_ROUTE = "/"
export const GIWA_FUNDS_ROUTE = "/funds"
export const GIWA_SAVINGS_ROUTE = "/savings"
export const GIWA_ADMIN_ROUTE = "/admin"
export const GIWA_ADMIN_PRICES_ROUTE = "/admin/prices"
export const GIWA_ADMIN_CONFIG_ROUTE = "/admin/config"
export const GIWA_ADMIN_FEATURED_ROUTE = "/admin/featured"
export const GIWA_ADMIN_OPERATIONS_ROUTE = "/admin/operations"
export const GIWA_ADMIN_MONITORING_ROUTE = "/admin/monitoring"
export const GIWA_PORTFOLIO_ROUTE = "/portfolio"
export const GIWA_PRODUCT_ROUTE = "/product/:id"

export function giwaProductPath(productId: string) {
  return `/product/${productId}`
}

export const GIWA_STOCKS_ROUTE = "/stocks"
export const GIWA_ADMIN_STOCKS_ROUTE = "/admin/stocks"

/** Keep the unique Savings account identity when several vaults accept the same asset. */
export function giwaSavingsPath(symbol: string, accountKey: string) {
  return `${GIWA_SAVINGS_ROUTE}?asset=${encodeURIComponent(symbol)}&account=${encodeURIComponent(accountKey)}`
}

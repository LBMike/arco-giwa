export const GIWA_PREPROD_ROUTE = "/app"
export const GIWA_SAVINGS_ROUTE = "/app/savings"
export const GIWA_ADMIN_ROUTE = "/app/admin"
export const GIWA_ADMIN_PRICES_ROUTE = "/app/admin/prices"
export const GIWA_ADMIN_CONFIG_ROUTE = "/app/admin/config"
export const GIWA_ADMIN_FEATURED_ROUTE = "/app/admin/featured"
export const GIWA_ADMIN_OPERATIONS_ROUTE = "/app/admin/operations"
export const GIWA_ADMIN_MONITORING_ROUTE = "/app/admin/monitoring"
export const GIWA_PORTFOLIO_ROUTE = "/app/portfolio"
export const GIWA_PRODUCT_ROUTE = "/app/product/:id"

export function giwaProductPath(productId: string) {
  return `/app/product/${productId}`
}

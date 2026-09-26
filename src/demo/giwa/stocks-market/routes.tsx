import { lazy, Suspense, type ReactNode } from "react"
import type { RouteObject } from "react-router-dom"
import { GIWA_ADMIN_CONSOLE_URL } from "../config"
import { GIWA_ADMIN_STOCKS_ROUTE, GIWA_STOCKS_ROUTE } from "../routes"
const StocksPage = lazy(() => import("./StocksPages").then(module => ({ default: module.StocksPage })))
// Pure, so a build with VITE_ADMIN_CONSOLE_URL, which never routes to it, leaves the page and its chunk out.
const StocksAdminPage = /* @__PURE__ */ lazy(() => import("./StocksAdminPage").then(module => ({ default: module.StocksAdminPage })))
/**
 * These are top-level siblings; Stocks admin never inherits the legacy operator gate. With the admin console configured
 * at build time (VITE_ADMIN_CONSOLE_URL) there is no /admin/stocks here: the customer app sends it to the console with
 * the rest of /admin.
 */
export function stocksRoutes(shell: ReactNode): RouteObject[] {
  const stocks: RouteObject = { path: GIWA_STOCKS_ROUTE, element: shell, children: [{ index: true, element: <Suspense fallback={<p role="status">Loading Stocks…</p>}><StocksPage /></Suspense> }] }
  return GIWA_ADMIN_CONSOLE_URL
    ? [stocks]
    : [stocks, { path: GIWA_ADMIN_STOCKS_ROUTE, element: shell, children: [{ index: true, element: <Suspense fallback={<p role="status">Loading Stocks admin…</p>}><StocksAdminPage /></Suspense> }] }]
}

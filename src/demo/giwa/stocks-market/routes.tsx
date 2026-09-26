import { lazy, Suspense, type ReactNode } from "react"
import type { RouteObject } from "react-router-dom"
import { GIWA_ADMIN_STOCKS_ROUTE, GIWA_STOCKS_ROUTE } from "../routes"
const StocksPage = lazy(() => import("./StocksPages").then(module => ({ default: module.StocksPage })))
const StocksAdminPage = lazy(() => import("./StocksPages").then(module => ({ default: module.StocksAdminPage })))
/** These are top-level siblings; Stocks admin never inherits the legacy operator gate. */
export function stocksRoutes(shell: ReactNode): RouteObject[] {
  return [
    { path: GIWA_STOCKS_ROUTE, element: shell, children: [{ index: true, element: <Suspense fallback={<p role="status">Loading Stocks…</p>}><StocksPage /></Suspense> }] },
    { path: GIWA_ADMIN_STOCKS_ROUTE, element: shell, children: [{ index: true, element: <Suspense fallback={<p role="status">Loading Stocks admin…</p>}><StocksAdminPage /></Suspense> }] },
  ]
}

import React, { Suspense, lazy } from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, Navigate, RouterProvider, useLocation, useParams, type RouteObject } from 'react-router-dom'
import { GIWA_ADMIN_OPERATIONS_ROUTE, GIWA_ADMIN_ROUTE, GIWA_PREPROD_ROUTE } from './demo/giwa/routes'
import { stocksRoutes } from './demo/giwa/stocks-market/routes'
import { DemoPresentationContext } from './demo/giwa/demo-presentation'
import { GIWA_ADMIN_CONSOLE_URL, GIWA_CUSTOMER_PRESENTATION } from './demo/giwa/config'
import { AdminConsoleRedirect } from './demo/giwa/AdminConsoleRedirect'
import { adminConsoleTarget, isLegacyAdminPath } from './demo/giwa/admin-console-url'
import './index.css'
import './demo/theme.css'

const GiwaPreprodApp = lazy(() => import('./demo/giwa/GiwaPreprodApp').then((mod) => ({ default: mod.GiwaPreprodApp })))
const GiwaPreprodProviders = lazy(() => import('./demo/giwa/providers').then((mod) => ({ default: mod.GiwaPreprodProviders })))
const GiwaHomePage = lazy(() => import('./demo/giwa/HomePage'))
const GiwaInvestorPage = lazy(() => import('./demo/giwa/Investor'))
// The legacy in-app admin pages (local demo). Pure, so a build with VITE_ADMIN_CONSOLE_URL, which never routes to
// them (adminRoute below), leaves them and their chunks out of the customer bundle.
const RequireGiwaAdmin = /* @__PURE__ */ lazy(() => import('./demo/giwa/RequireGiwaAdmin').then((mod) => ({ default: mod.RequireGiwaAdmin })))
const GiwaAdminLayout = /* @__PURE__ */ lazy(() => import('./demo/giwa/GiwaAdminLayout').then((mod) => ({ default: mod.GiwaAdminLayout })))
const GiwaAdminPricesPage = /* @__PURE__ */ lazy(() => import('./demo/giwa/AdminPrices'))
const GiwaAdminConfigPage = /* @__PURE__ */ lazy(() => import('./demo/giwa/AdminConfig'))
const GiwaAdminFeaturedPage = /* @__PURE__ */ lazy(() => import('./demo/giwa/AdminFeatured'))
const GiwaAdminOperationsPage = /* @__PURE__ */ lazy(() => import('./demo/giwa/AdminOperations'))
const GiwaAdminMonitoringPage = /* @__PURE__ */ lazy(() => import('./demo/giwa/AdminMonitoring'))
const GiwaAdminArcoUSDPage = /* @__PURE__ */ lazy(() => import('./demo/giwa/AdminArcoUSD'))
const GiwaPortfolioPage = lazy(() => import('./demo/giwa/PortfolioPage'))
const GiwaProductDetailPage = lazy(() => import('./demo/giwa/ProductDetailPage'))
const GiwaSavingsPage = lazy(() => import('./demo/giwa/SavingsPage'))

function giwaRoute(element: React.ReactNode) {
  return <Suspense fallback={null}>{element}</Suspense>
}

// Earlier lives of this app served /app/* (and, pre-extraction, /app/giwa-preprod/*).
// On the app.arco.financial subdomain routes are root-based — redirect legacy deep links.
function LegacyAppRedirect() {
  const params = useParams()
  const location = useLocation()
  let rest = params['*'] ?? ''
  if (rest === 'giwa-preprod') rest = ''
  else if (rest.startsWith('giwa-preprod/')) rest = rest.slice('giwa-preprod/'.length)
  return <Navigate to={`/${rest}${location.search}`} replace />
}

// With the admin console configured at build time (VITE_ADMIN_CONSOLE_URL, docs/admin-console.md), /admin, /admin/*
// and /admin/stocks leave for it; without it the legacy in-app admin stays (local demo).
const adminRoute: RouteObject = GIWA_ADMIN_CONSOLE_URL
  ? { path: `${GIWA_ADMIN_ROUTE}/*`, element: <AdminConsoleRedirect consoleUrl={GIWA_ADMIN_CONSOLE_URL} /> }
  : {
      path: GIWA_ADMIN_ROUTE,
      element: giwaRoute(<GiwaPreprodApp admin />),
      children: [
        {
          element: giwaRoute(<RequireGiwaAdmin><GiwaAdminLayout /></RequireGiwaAdmin>),
          children: [
            { index: true, element: <Navigate to={GIWA_ADMIN_OPERATIONS_ROUTE} replace /> },
            { path: 'prices', element: giwaRoute(<GiwaAdminPricesPage />) },
            { path: 'config', element: giwaRoute(<GiwaAdminConfigPage />) },
            { path: 'featured', element: giwaRoute(<GiwaAdminFeaturedPage />) },
            { path: 'operations', element: giwaRoute(<GiwaAdminOperationsPage />) },
            { path: 'monitoring', element: giwaRoute(<GiwaAdminMonitoringPage />) },
            { path: 'arcousd', element: giwaRoute(<GiwaAdminArcoUSDPage />) },
            { path: 'vaults', element: <Navigate to={GIWA_ADMIN_OPERATIONS_ROUTE} replace /> },
          ],
        },
      ],
    }

const router = createBrowserRouter([
  { path: '/app/*', element: <LegacyAppRedirect /> },
  ...stocksRoutes(giwaRoute(<GiwaPreprodApp />)),
  {
    path: GIWA_PREPROD_ROUTE,
    element: giwaRoute(<GiwaPreprodApp />),
    children: [
      { index: true, element: giwaRoute(<GiwaHomePage />) },
      { path: 'funds', element: giwaRoute(<GiwaInvestorPage />) },
      { path: 'savings', element: giwaRoute(<GiwaSavingsPage />) },
      { path: 'portfolio', element: giwaRoute(<GiwaPortfolioPage />) },
      { path: 'product/:id', element: giwaRoute(<GiwaProductDetailPage />) },
    ],
  },
  adminRoute,
  { path: '*', element: <Navigate to={GIWA_PREPROD_ROUTE} replace /> },
])

// A page load of /admin… with the admin console configured leaves before the app and its wallet providers start;
// adminRoute above covers links followed inside the app.
const consoleTarget =
  GIWA_ADMIN_CONSOLE_URL && isLegacyAdminPath(window.location.pathname) ? adminConsoleTarget(GIWA_ADMIN_CONSOLE_URL, window.location.pathname) : null

if (consoleTarget) {
  window.location.replace(consoleTarget)
} else {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Suspense fallback={null}>
        <DemoPresentationContext.Provider value={GIWA_CUSTOMER_PRESENTATION}>
          <GiwaPreprodProviders><RouterProvider router={router} /></GiwaPreprodProviders>
        </DemoPresentationContext.Provider>
      </Suspense>
    </React.StrictMode>,
  )
}

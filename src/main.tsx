import React, { Suspense, lazy } from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, Navigate, RouterProvider, useLocation, useParams } from 'react-router-dom'
import { GIWA_ADMIN_OPERATIONS_ROUTE, GIWA_ADMIN_ROUTE, GIWA_PREPROD_ROUTE } from './demo/giwa/routes'
import { stocksRoutes } from './demo/giwa/stocks-market/routes'
import './index.css'
import './demo/theme.css'

const GiwaPreprodApp = lazy(() => import('./demo/giwa/GiwaPreprodApp').then((mod) => ({ default: mod.GiwaPreprodApp })))
const GiwaPreprodProviders = lazy(() => import('./demo/giwa/providers').then((mod) => ({ default: mod.GiwaPreprodProviders })))
const GiwaInvestorPage = lazy(() => import('./demo/giwa/Investor'))
const RequireGiwaAdmin = lazy(() => import('./demo/giwa/RequireGiwaAdmin').then((mod) => ({ default: mod.RequireGiwaAdmin })))
const GiwaAdminLayout = lazy(() => import('./demo/giwa/GiwaAdminLayout').then((mod) => ({ default: mod.GiwaAdminLayout })))
const GiwaAdminPricesPage = lazy(() => import('./demo/giwa/AdminPrices'))
const GiwaAdminConfigPage = lazy(() => import('./demo/giwa/AdminConfig'))
const GiwaAdminFeaturedPage = lazy(() => import('./demo/giwa/AdminFeatured'))
const GiwaAdminOperationsPage = lazy(() => import('./demo/giwa/AdminOperations'))
const GiwaAdminMonitoringPage = lazy(() => import('./demo/giwa/AdminMonitoring'))
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

const router = createBrowserRouter([
  { path: '/app/*', element: <LegacyAppRedirect /> },
  ...stocksRoutes(giwaRoute(<GiwaPreprodApp />)),
  {
    path: GIWA_PREPROD_ROUTE,
    element: giwaRoute(<GiwaPreprodApp />),
    children: [
      { index: true, element: giwaRoute(<GiwaInvestorPage />) },
      { path: 'savings', element: giwaRoute(<GiwaSavingsPage />) },
      { path: 'portfolio', element: giwaRoute(<GiwaPortfolioPage />) },
      { path: 'product/:id', element: giwaRoute(<GiwaProductDetailPage />) },
    ],
  },
  {
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
          { path: 'vaults', element: <Navigate to={GIWA_ADMIN_OPERATIONS_ROUTE} replace /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to={GIWA_PREPROD_ROUTE} replace /> },
])

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Suspense fallback={null}>
      <GiwaPreprodProviders><RouterProvider router={router} /></GiwaPreprodProviders>
    </Suspense>
  </React.StrictMode>,
)

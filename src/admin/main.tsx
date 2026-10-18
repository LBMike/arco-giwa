import React, { lazy } from "react"
import ReactDOM from "react-dom/client"
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom"
import { DemoPresentationContext } from "../demo/giwa/demo-presentation"
import { GiwaPreprodProviders } from "../demo/giwa/providers"
import { AdminConsoleApp } from "./AdminConsoleApp"
import { StocksRoute } from "./StocksSection"
import { VaultsLayout } from "./VaultsSection"
import "../index.css"
import "../demo/theme.css"

// The same page modules as the customer app's legacy /admin, loaded per tab.
const OperationsPage = lazy(() => import("../demo/giwa/AdminOperations"))
const PricesPage = lazy(() => import("../demo/giwa/AdminPrices"))
const ConfigPage = lazy(() => import("../demo/giwa/AdminConfig"))
const FeaturedPage = lazy(() => import("../demo/giwa/AdminFeatured"))
const MonitoringPage = lazy(() => import("../demo/giwa/AdminMonitoring"))
const ArcoUSDPage = lazy(() => import("../demo/giwa/AdminArcoUSD"))

const router = createBrowserRouter([
  {
    path: "/",
    element: <AdminConsoleApp />,
    children: [
      {
        path: "vaults",
        element: <VaultsLayout />,
        children: [
          { index: true, element: <Navigate to="/vaults/operations" replace /> },
          { path: "operations", element: <OperationsPage /> },
          { path: "prices", element: <PricesPage /> },
          { path: "config", element: <ConfigPage /> },
          { path: "featured", element: <FeaturedPage /> },
          { path: "monitoring", element: <MonitoringPage /> },
          { path: "arcousd", element: <ArcoUSDPage /> },
        ],
      },
      { path: "stocks", element: <Navigate to="/stocks/limits" replace /> },
      { path: "stocks/:section", element: <StocksRoute /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
])

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* Operators see the full technical detail (no customer presentation mode). */}
    <DemoPresentationContext.Provider value={false}>
      <GiwaPreprodProviders>
        <RouterProvider router={router} />
      </GiwaPreprodProviders>
    </DemoPresentationContext.Provider>
  </React.StrictMode>,
)

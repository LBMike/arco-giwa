import {
  GIWA_ADMIN_ROUTE,
  GIWA_ADMIN_STOCKS_ROUTE,
  GIWA_FUNDS_ROUTE,
  GIWA_PORTFOLIO_ROUTE,
  GIWA_PREPROD_ROUTE,
  GIWA_SAVINGS_ROUTE,
  GIWA_STOCKS_ROUTE,
} from "./routes"

// Investor shell navigation model, shared by the desktop sidebar and the mobile drawer. Pure (no
// React) so ordering, labels and active matching are unit-tested without rendering.

export type InvestorNavItemId = "home" | "savings" | "funds" | "stocks" | "portfolio" | "send" | "admin"

export type InvestorNavItem = {
  id: InvestorNavItemId
  label: string
  // null = no route exists; the item renders as a disabled, non-interactive row.
  to: string | null
  disabled?: boolean
  note?: string
}

export type InvestorNavSection = {
  id: "home" | "invest" | "manage"
  // null = no visible label (the Home section).
  label: string | null
  items: InvestorNavItem[]
}

export const INVESTOR_NAV_SECTIONS: readonly InvestorNavSection[] = [
  { id: "home", label: null, items: [{ id: "home", label: "Home", to: GIWA_PREPROD_ROUTE }] },
  {
    id: "invest",
    label: "Invest",
    items: [
      { id: "savings", label: "Savings", to: GIWA_SAVINGS_ROUTE },
      { id: "funds", label: "Funds", to: GIWA_FUNDS_ROUTE },
      { id: "stocks", label: "Stocks", to: GIWA_STOCKS_ROUTE },
    ],
  },
  {
    id: "manage",
    label: "Manage",
    items: [
      { id: "portfolio", label: "Portfolio", to: GIWA_PORTFOLIO_ROUTE },
      // Send stays out of the menu until the feature and its route exist.
    ],
  },
]

// VISIBILITY only (allowlisted wallets); the admin routes keep their own guard.
export const INVESTOR_NAV_ADMIN_ITEM: InvestorNavItem = { id: "admin", label: "Admin", to: GIWA_ADMIN_ROUTE }

export function investorNavSections(isAdmin: boolean): InvestorNavSection[] {
  return INVESTOR_NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.id === "manage" && isAdmin ? [...section.items, INVESTOR_NAV_ADMIN_ITEM] : [...section.items],
  }))
}

function within(pathname: string, base: string) {
  return pathname === base || pathname.startsWith(`${base}/`)
}

export function isNavItemActive(item: Pick<InvestorNavItem, "id">, pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname
  switch (item.id) {
    case "home":
      return path === GIWA_PREPROD_ROUTE
    case "savings":
      return within(path, GIWA_SAVINGS_ROUTE)
    case "funds":
      return path === GIWA_FUNDS_ROUTE || path.startsWith("/product/")
    case "stocks":
      return path === GIWA_STOCKS_ROUTE || path === GIWA_ADMIN_STOCKS_ROUTE
    case "portfolio":
      return within(path, GIWA_PORTFOLIO_ROUTE)
    case "admin":
      return within(path, GIWA_ADMIN_ROUTE) && !within(path, GIWA_ADMIN_STOCKS_ROUTE)
    case "send":
      return false
  }
}

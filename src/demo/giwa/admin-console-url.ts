import { GIWA_ADMIN_ROUTE } from "./routes"

// Legacy /admin/<tab> pages that the admin console keeps under /vaults/<tab>.
const VAULT_TABS = new Set(["operations", "prices", "config", "featured", "monitoring"])

/**
 * Where a legacy admin path of the customer app goes when the build names the separate admin console
 * (VITE_ADMIN_CONSOLE_URL, docs/admin-console.md): a Vault page keeps its tab, /admin/stocks opens the
 * console's Stocks section and anything else under /admin opens the console's start page. Query and hash are
 * dropped. Null when the configured address is not an absolute http(s) URL, so a misconfigured build shows an
 * error instead of navigating somewhere unintended.
 */
export function adminConsoleTarget(consoleUrl: string, pathname: string): string | null {
  let base: URL
  try {
    base = new URL(consoleUrl)
  } catch {
    return null
  }
  if ((base.protocol !== "https:" && base.protocol !== "http:") || base.username || base.password) return null
  const root = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`
  return new URL(`${root}${consolePath(pathname)}`, base.origin).toString()
}

/** Whether a customer-app path is one of the legacy admin pages: /admin, /admin/… and /admin/stocks. */
export function isLegacyAdminPath(pathname: string): boolean {
  const path = pathname.toLowerCase()
  return path === GIWA_ADMIN_ROUTE || path.startsWith(`${GIWA_ADMIN_ROUTE}/`)
}

function consolePath(pathname: string): string {
  const path = pathname.toLowerCase()
  const [section = ""] = path.startsWith(`${GIWA_ADMIN_ROUTE}/`) ? path.slice(GIWA_ADMIN_ROUTE.length + 1).split("/") : []
  if (VAULT_TABS.has(section)) return `vaults/${section}`
  if (section === "vaults" || section === "stocks") return section
  return ""
}

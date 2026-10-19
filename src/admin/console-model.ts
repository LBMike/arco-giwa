// Pure model of the admin console: navigation, the server's permission answer and the sign-in gate.
// No React, no I/O. Access decisions come only from GET /api/v1/admin/session; every admin route on the
// server checks its own permission again, so this model only shapes what the console offers.

export type ConsoleGroup = "vaults" | "stocks"
export type StocksTabId = "limits" | "trading-control" | "overview" | "orders" | "reconciliation" | "audit" | "held"
export type VaultsTabId = "operations" | "prices" | "config" | "featured" | "monitoring" | "arcousd"
export type ConsoleTab = { readonly group: ConsoleGroup; readonly id: string; readonly label: string; readonly path: string }

export const VAULT_TABS: readonly ConsoleTab[] = [
  { group: "vaults", id: "operations", label: "Operations", path: "/vaults/operations" },
  { group: "vaults", id: "prices", label: "Prices", path: "/vaults/prices" },
  { group: "vaults", id: "config", label: "Vault Config", path: "/vaults/config" },
  { group: "vaults", id: "featured", label: "Featured", path: "/vaults/featured" },
  { group: "vaults", id: "monitoring", label: "Monitoring", path: "/vaults/monitoring" },
  { group: "vaults", id: "arcousd", label: "ArcoUSD", path: "/vaults/arcousd" },
]

// Limits is the first Stocks page: per-stock on/off and daily caps are the everyday control.
export const STOCKS_TABS: readonly ConsoleTab[] = [
  { group: "stocks", id: "limits", label: "Limits", path: "/stocks/limits" },
  { group: "stocks", id: "trading-control", label: "Trading control", path: "/stocks/trading-control" },
  { group: "stocks", id: "overview", label: "Overview", path: "/stocks/overview" },
  { group: "stocks", id: "orders", label: "Orders", path: "/stocks/orders" },
  { group: "stocks", id: "reconciliation", label: "Reconciliation", path: "/stocks/reconciliation" },
  { group: "stocks", id: "audit", label: "Audit", path: "/stocks/audit" },
  { group: "stocks", id: "held", label: "Held payments", path: "/stocks/held" },
]

export const CONSOLE_NAV: readonly { readonly group: ConsoleGroup; readonly label: string; readonly tabs: readonly ConsoleTab[] }[] = [
  { group: "vaults", label: "Vaults", tabs: VAULT_TABS },
  { group: "stocks", label: "Stocks", tabs: STOCKS_TABS },
]

export function isStocksTab(value: string | undefined): value is StocksTabId {
  return STOCKS_TABS.some((tab) => tab.id === value)
}

export function stocksTabPath(id: StocksTabId): string {
  return `/stocks/${id}`
}

// ── GET /api/v1/admin/session ─────────────────────────────────────────────

export type OperatorGrant = { readonly operatorId: string; readonly permissions: readonly string[] }
export type AdminSessionInfo = { readonly wallet: string; readonly vault: OperatorGrant | null; readonly stocks: OperatorGrant | null }

export class AdminSessionContractError extends Error {
  constructor(readonly path: string) {
    super(`Admin session response does not match the contract at ${path}`)
  }
}

function grant(value: unknown, path: string): OperatorGrant | null {
  if (value === null) return null
  if (value === undefined || typeof value !== "object" || Array.isArray(value)) throw new AdminSessionContractError(path)
  const { operatorId, permissions } = value as Record<string, unknown>
  if (typeof operatorId !== "string" || operatorId.length === 0 || operatorId.length > 128) throw new AdminSessionContractError(`${path}.operatorId`)
  if (!Array.isArray(permissions) || !permissions.every((permission) => typeof permission === "string")) throw new AdminSessionContractError(`${path}.permissions`)
  return { operatorId, permissions: [...permissions] as string[] }
}

/** Strict: a malformed answer grants nothing. */
export function parseAdminSession(body: unknown): AdminSessionInfo {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new AdminSessionContractError("$")
  const root = body as Record<string, unknown>
  if (typeof root.wallet !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(root.wallet)) throw new AdminSessionContractError("$.wallet")
  return { wallet: root.wallet, vault: grant(root.vault, "$.vault"), stocks: grant(root.stocks, "$.stocks") }
}

export type ConsoleAccess = {
  readonly vaultRead: boolean
  readonly vaultWrite: boolean
  readonly stocksRead: boolean
  readonly stocksControl: boolean
}

export function accessOf(info: AdminSessionInfo): ConsoleAccess {
  const vault = info.vault?.permissions ?? []
  const stocks = info.stocks?.permissions ?? []
  return {
    vaultRead: vault.includes("vault:read"),
    vaultWrite: vault.includes("vault:write"),
    stocksRead: stocks.includes("stocks:read"),
    stocksControl: stocks.includes("stocks:control"),
  }
}

/** Every page of a group reads first, so a group is offered only with its read permission. */
export function groupVisible(access: ConsoleAccess, group: ConsoleGroup): boolean {
  return group === "vaults" ? access.vaultRead : access.stocksRead
}

export function visibleNav(access: ConsoleAccess) {
  return CONSOLE_NAV.filter((entry) => groupVisible(access, entry.group))
}

/** Where "/" goes: the first tab the operator may read, or null for a wallet with no admin access. */
export function defaultPath(access: ConsoleAccess): string | null {
  return visibleNav(access)[0]?.tabs[0]?.path ?? null
}

export function groupOfPath(pathname: string): ConsoleGroup | null {
  if (pathname === "/vaults" || pathname.startsWith("/vaults/")) return "vaults"
  if (pathname === "/stocks" || pathname.startsWith("/stocks/")) return "stocks"
  return null
}

export const READ_ONLY_VAULT_REASON = "Read only: this operator has vault:read without vault:write."

// ── Sign-in gate ──────────────────────────────────────────────────────────

export type HostStatus = "signed-out" | "signing-in" | "authenticated" | "error"
export type PermissionState =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "ok"; readonly info: AdminSessionInfo }
  | { readonly status: "error"; readonly message: string }

export type GateInput = {
  readonly walletConnected: boolean
  readonly walletOnGiwa: boolean
  readonly walletCanSign: boolean
  readonly hostStatus: HostStatus
  /** The session host's stable error code (SESSION_EXPIRED, SESSION_REJECTED, AUTH_REJECTED, …). */
  readonly hostError: string | null
  readonly hasSession: boolean
  readonly permissions: PermissionState
}

export type SignInNotice = { readonly kind: "expired" | "rejected" | "failed"; readonly code: string }

export type GateView =
  | { readonly kind: "connect-wallet" }
  | { readonly kind: "wrong-network" }
  | { readonly kind: "wallet-unavailable" }
  | { readonly kind: "sign-in"; readonly notice: SignInNotice | null }
  | { readonly kind: "signing-in" }
  | { readonly kind: "checking" }
  | { readonly kind: "no-access"; readonly wallet: string }
  | { readonly kind: "session-error"; readonly message: string }
  | { readonly kind: "ready"; readonly info: AdminSessionInfo; readonly access: ConsoleAccess }

function noticeOf(code: string | null): SignInNotice | null {
  if (!code) return null
  if (code === "SESSION_EXPIRED") return { kind: "expired", code }
  // A 401 from any admin request (or /session) invalidates the session: sign in again.
  if (code === "SESSION_REJECTED") return { kind: "rejected", code }
  return { kind: "failed", code }
}

export function gateView(input: GateInput): GateView {
  if (!input.walletConnected) return { kind: "connect-wallet" }
  if (!input.walletOnGiwa) return { kind: "wrong-network" }
  if (!input.hasSession) {
    if (input.hostStatus === "signing-in") return { kind: "signing-in" }
    if (!input.walletCanSign) return { kind: "wallet-unavailable" }
    return { kind: "sign-in", notice: noticeOf(input.hostError) }
  }
  const { permissions } = input
  if (permissions.status === "ok") {
    const access = accessOf(permissions.info)
    if (!access.vaultRead && !access.stocksRead) return { kind: "no-access", wallet: permissions.info.wallet }
    return { kind: "ready", info: permissions.info, access }
  }
  if (permissions.status === "error") return { kind: "session-error", message: permissions.message }
  return { kind: "checking" }
}

/** Human text for the session host's stable failure codes; the codes never carry provider messages. */
export function signInFailureText(code: string): string {
  switch (code) {
    case "AUTH_REJECTED":
      return "The server rejected the sign-in (the signing domain must be listed in CORS_ALLOWED_ORIGINS)."
    case "NONCE_EXPIRED":
      return "The sign-in request expired before the wallet signed. Try again."
    case "INVALID_SIGNATURE":
    case "WALLET_SIGNATURE_REJECTED":
      return "The wallet did not return a valid signature."
    case "AUTH_UNAVAILABLE":
    case "AUTH_TIMEOUT":
      return "The API did not answer the sign-in request."
    case "INVALID_AUTH_CONTEXT":
      return "The console's API address is not configured correctly (VITE_ARCO_API_BASE)."
    default:
      return `Sign-in failed (${code}).`
  }
}

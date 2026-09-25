import type { ReactNode } from "react"
import { NavLink } from "react-router-dom"
import { KeyRound, Loader2, LogOut, Network, ShieldAlert, ShieldOff, Wallet, X } from "lucide-react"
import {
  READ_ONLY_VAULT_REASON,
  signInFailureText,
  visibleNav,
  type AdminSessionInfo,
  type ConsoleAccess,
  type ConsoleGroup,
  type GateView,
  type OperatorGrant,
} from "./console-model"

// Presentation only: every component here is a pure function of its props (rendered directly by tests).

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"
const BUTTON = `inline-flex min-h-10 items-center justify-center gap-2 rounded-[var(--radius-control)] px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`
const PRIMARY = `${BUTTON} bg-[var(--color-arco-ink)] text-[var(--color-arco-on-dark)]`
const SECONDARY = `${BUTTON} border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] text-[var(--color-arco-ink)]`

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
}

/** "14:05 UTC": locale-independent, so every operator reads the same time. */
export function formatClockUtc(ms: number): string {
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(11, 16)} UTC` : "—"
}

function ConsoleFrame({ children }: { children: ReactNode }) {
  return <div className="arco-demo flex min-h-screen flex-col bg-[var(--color-arco-page)] text-[var(--color-arco-ink)]">{children}</div>
}

export type GateActions = {
  readonly connect: () => void
  readonly switchNetwork: () => void
  readonly signIn: () => void
  readonly retry: () => void
  readonly signOut: () => void
  readonly disconnect: () => void
}

/** Everything before a session with permissions: one card and one next step. */
export function ConsoleGate({ view, wallet, actions }: { view: Exclude<GateView, { kind: "ready" }>; wallet: string | null; actions: GateActions }) {
  return (
    <ConsoleFrame>
      <main className="mx-auto flex w-full max-w-[560px] flex-1 flex-col justify-center px-4 py-10">
        <section
          aria-labelledby="console-gate-title"
          data-testid={`console-gate-${view.kind}`}
          className="w-full rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-6 shadow-[var(--shadow-control)]"
        >
          <div className="flex items-center gap-2">
            <img src="/arco-icon.svg" alt="" className="h-[24px] w-[26px] shrink-0" />
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-arco-text-soft)]">Arco admin console</p>
          </div>
          <GateBody view={view} wallet={wallet} actions={actions} />
        </section>
      </main>
    </ConsoleFrame>
  )
}

function GateTitle({ children }: { children: ReactNode }) {
  return (
    <h1 id="console-gate-title" className="mt-4 text-xl font-semibold text-[var(--color-arco-ink)]">
      {children}
    </h1>
  )
}

function GateText({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-sm leading-6 text-[var(--color-arco-text-soft)]">{children}</p>
}

function GateButtons({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex flex-wrap gap-2">{children}</div>
}

function GateBody({ view, wallet, actions }: { view: Exclude<GateView, { kind: "ready" }>; wallet: string | null; actions: GateActions }) {
  switch (view.kind) {
    case "connect-wallet":
      return (
        <>
          <GateTitle>Connect an operator wallet</GateTitle>
          <GateText>
            Sign in with a wallet the server lists as an operator. The server decides access: ADMIN_OPERATORS for Vaults and the Stocks operator
            directory for Stocks.
          </GateText>
          <GateButtons>
            <button type="button" className={PRIMARY} onClick={actions.connect}>
              <Wallet aria-hidden="true" className="size-4" />
              Connect wallet
            </button>
          </GateButtons>
        </>
      )
    case "wrong-network":
      return (
        <>
          <GateTitle>Switch to GIWA Sepolia</GateTitle>
          <GateText>Operator sessions are issued for chain 91342 only.</GateText>
          <GateButtons>
            <button type="button" className={PRIMARY} onClick={actions.switchNetwork}>
              <Network aria-hidden="true" className="size-4" />
              Switch network
            </button>
            <button type="button" className={SECONDARY} onClick={actions.disconnect}>
              Disconnect
            </button>
          </GateButtons>
        </>
      )
    case "wallet-unavailable":
      return (
        <>
          <GateTitle>This wallet cannot sign here</GateTitle>
          <GateText>The connected wallet is not ready to sign a message. Reconnect it, then sign in.</GateText>
          <GateButtons>
            <button type="button" className={SECONDARY} onClick={actions.disconnect}>
              Disconnect
            </button>
          </GateButtons>
        </>
      )
    case "sign-in":
      return (
        <>
          <GateTitle>Sign in</GateTitle>
          {view.notice && (
            <div
              role="alert"
              data-testid={`console-notice-${view.notice.kind}`}
              className="mt-3 flex items-start gap-2 rounded-[var(--radius-card)] border border-dashed border-[var(--color-arco-ink)] p-3 text-sm text-[var(--color-arco-ink)]"
            >
              <KeyRound aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>
                {view.notice.kind === "expired"
                  ? "Your operator session expired (sessions last 15 minutes). Sign in again to continue."
                  : view.notice.kind === "rejected"
                    ? "The server did not accept your session (401). Sign in again to continue."
                    : signInFailureText(view.notice.code)}
              </span>
            </div>
          )}
          <GateText>
            Signing a message proves you control {wallet ? <span className="font-mono">{shortAddress(wallet)}</span> : "this wallet"}. It does not
            authorize a transaction. The session lasts at most 15 minutes and is kept in this tab's memory only.
          </GateText>
          <GateButtons>
            <button type="button" className={PRIMARY} onClick={actions.signIn}>
              <KeyRound aria-hidden="true" className="size-4" />
              Sign in with wallet
            </button>
            <button type="button" className={SECONDARY} onClick={actions.disconnect}>
              Disconnect
            </button>
          </GateButtons>
        </>
      )
    case "signing-in":
      return (
        <>
          <GateTitle>Waiting for the wallet</GateTitle>
          <p role="status" className="mt-2 flex items-center gap-2 text-sm text-[var(--color-arco-text-soft)]">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            Approve the sign-in message in your wallet.
          </p>
        </>
      )
    case "checking":
      return (
        <>
          <GateTitle>Checking operator permissions</GateTitle>
          <p role="status" className="mt-2 flex items-center gap-2 text-sm text-[var(--color-arco-text-soft)]">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            Asking the server what this session may do.
          </p>
        </>
      )
    case "no-access":
      return (
        <>
          <GateTitle>
            <span className="inline-flex items-center gap-2">
              <ShieldOff aria-hidden="true" className="size-5" />
              No admin access (403)
            </span>
          </GateTitle>
          <GateText>
            The server accepted the session for <span className="font-mono">{shortAddress(view.wallet)}</span>, but this wallet has no Vault or Stocks
            operator permission.
          </GateText>
          <GateText>Ask an administrator to add it to ADMIN_OPERATORS (Vaults) or to the Stocks operator directory (Stocks).</GateText>
          <GateButtons>
            <button type="button" className={SECONDARY} onClick={actions.signOut}>
              Sign out
            </button>
            <button type="button" className={SECONDARY} onClick={actions.disconnect}>
              Disconnect
            </button>
          </GateButtons>
        </>
      )
    case "session-error":
      return (
        <>
          <GateTitle>Could not read operator permissions</GateTitle>
          <p role="alert" className="mt-2 break-words text-sm text-[var(--color-arco-down)]">
            {view.message}
          </p>
          <GateButtons>
            <button type="button" className={PRIMARY} onClick={actions.retry}>
              Try again
            </button>
            <button type="button" className={SECONDARY} onClick={actions.signOut}>
              Sign out
            </button>
          </GateButtons>
        </>
      )
  }
}

function GrantChip({ label, grant }: { label: string; grant: OperatorGrant }) {
  return (
    <span className="max-w-full truncate rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2.5 py-1 text-[11px] text-[var(--color-arco-text-soft)]">
      {label}: <span className="font-medium text-[var(--color-arco-ink)]">{grant.operatorId}</span> · {grant.permissions.join(" ") || "no permissions"}
    </span>
  )
}

/** The signed-in frame: who, until when, what the server granted, and the permitted navigation only. */
export function ConsoleShell({
  info,
  access,
  expiresAt,
  forbidden,
  onDismissForbidden,
  onSignOut,
  children,
}: {
  info: AdminSessionInfo
  access: ConsoleAccess
  expiresAt: number
  forbidden: boolean
  onDismissForbidden: () => void
  onSignOut: () => void
  children: ReactNode
}) {
  const nav = visibleNav(access)
  return (
    <ConsoleFrame>
      <header className="sticky top-0 z-40 border-b border-[var(--color-arco-border)] bg-[var(--color-arco-surface)]">
        <div className="mx-auto flex w-full max-w-[1512px] flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <img src="/arco-icon.svg" alt="" className="h-[28px] w-[30px] shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[var(--color-arco-ink)]">Arco admin</p>
              <p className="truncate text-[11px] text-[var(--color-arco-text-soft)]">
                <span className="font-mono">{shortAddress(info.wallet)}</span> · session until {formatClockUtc(expiresAt)}
              </p>
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {info.vault && <GrantChip label="Vaults" grant={info.vault} />}
            {info.stocks && <GrantChip label="Stocks" grant={info.stocks} />}
            <button type="button" onClick={onSignOut} className={`${SECONDARY} min-h-8 px-3 py-1 text-xs`}>
              <LogOut aria-hidden="true" className="size-3.5" />
              Sign out
            </button>
          </div>
        </div>
      </header>
      <div className="mx-auto grid w-full min-w-0 max-w-[1512px] flex-1 gap-6 px-4 py-6 md:px-8 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="Admin console" className="min-w-0 lg:sticky lg:top-[88px] lg:self-start" data-testid="console-nav">
          {nav.map((group) => (
            <div key={group.group} className="mb-3 min-w-0">
              <p id={`console-nav-${group.group}`} className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-[var(--color-arco-text-soft)]">
                {group.label}
              </p>
              {/* Narrow screens: one scrollable row per group. From lg: a vertical list. */}
              <ul aria-labelledby={`console-nav-${group.group}`} className="flex min-w-0 gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
                {group.tabs.map((tab) => (
                  <li key={tab.path} className="shrink-0">
                    <NavLink
                      to={tab.path}
                      className={({ isActive }) =>
                        `block whitespace-nowrap rounded-[var(--radius-control)] px-3 py-2 text-sm ${FOCUS} ${
                          isActive
                            ? "bg-[var(--color-arco-ink)] font-medium text-[var(--color-arco-on-dark)]"
                            : "text-[var(--color-arco-text)] hover:bg-[var(--color-arco-surface-muted)]"
                        }`
                      }
                    >
                      {tab.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <main id="admin-main" className="min-w-0 space-y-4">
          {forbidden && <ForbiddenNotice onDismiss={onDismissForbidden} />}
          {children}
        </main>
      </div>
    </ConsoleFrame>
  )
}

/** A request was refused with 403 while signed in: the operator lacks that permission (or it was just removed). */
export function ForbiddenNotice({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      role="alert"
      data-testid="console-forbidden"
      className="flex w-full items-start gap-2 rounded-[var(--radius-card)] border border-[var(--color-arco-down)] bg-[var(--color-arco-surface)] p-3"
    >
      <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--color-arco-down)]" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-[var(--color-arco-down)]">The server refused a request (403)</p>
        <p className="mt-0.5 text-xs leading-5 text-[var(--color-arco-text-soft)]">
          This operator lacks the permission for that action. The permissions shown above were read from the server again.
        </p>
      </div>
      <button type="button" aria-label="Dismiss" onClick={onDismiss} className={`rounded-[var(--radius-control)] p-1 text-[var(--color-arco-text-soft)] ${FOCUS}`}>
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  )
}

/** A group the operator may not read, reached by a link or a typed address. */
export function ForbiddenPanel({ group }: { group: ConsoleGroup }) {
  const name = group === "vaults" ? "Vaults" : "Stocks"
  const permission = group === "vaults" ? "vault:read" : "stocks:read"
  return (
    <section
      role="alert"
      data-testid="console-no-permission"
      className="w-full rounded-[var(--radius-card)] border border-dashed border-[var(--color-arco-ink)] bg-[var(--color-arco-surface)] p-6"
    >
      <ShieldOff aria-hidden="true" className="size-5 text-[var(--color-arco-ink)]" />
      <h1 className="mt-2 text-base font-semibold text-[var(--color-arco-ink)]">No {name} permission (403)</h1>
      <p className="mt-1 text-sm text-[var(--color-arco-text-soft)]">
        This operator does not have {permission}, and the server refuses these routes for it.
      </p>
    </section>
  )
}

export function ReadOnlyNotice({ reason = READ_ONLY_VAULT_REASON }: { reason?: string }) {
  return (
    <div
      role="status"
      data-testid="console-read-only"
      className="w-full rounded-[var(--radius-card)] border border-dashed border-[var(--color-arco-ink)] bg-[var(--color-arco-surface)] p-3 text-xs leading-5 text-[var(--color-arco-ink)]"
    >
      {reason} Write controls are disabled; the server refuses writes for this operator anyway.
    </div>
  )
}

export function LoadingPanel({ what }: { what: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-[var(--color-arco-text-soft)]">
      <Loader2 aria-hidden="true" className="size-4 animate-spin" />
      Loading {what}…
    </p>
  )
}

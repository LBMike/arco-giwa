import { DemoDetails, useDemoPresentation } from "../demo-presentation"
import { useCallback, useContext, useId, useMemo } from "react"
import { Link } from "react-router-dom"
import { GIWA_ADMIN_STOCKS_ROUTE, GIWA_STOCKS_ROUTE } from "../routes"
import { GiwaStocksAdminFeature } from "../stocks-admin"
import { GiwaStocksTradingControlFeature } from "../stocks-trading-control"
import { StocksExecutionProvider, StocksExecutionSessionNotice, useStocksExecutionCapability, useStocksOrderExecutionSlot } from "../stocks-execution-host"
import { StocksSignIn, useGiwaStocksHost } from "../stocks-host"
import { GiwaStocksFeature, createGiwaStocksHttpClient, type GiwaStocksFeatureProps } from "../stocks-investor"
import { StockMarketInvestPanel } from "./StockMarketInvestPanel"
import { createMarketClient } from "./client"
import { StocksPageEnvironment, usePageApiBase } from "./environment"
import { useStocksPageAccess } from "./page-access"
import { StocksMarketFeature, type StocksAsideView } from "./StocksMarketFeature"
import { StocksDemoMarketNotice } from "./StocksDemoMarketNotice"
/** Re-exported under the same name for the verification pages and DOM suites that import it from here. */
export { StocksPageEnvironment }
const link = "rounded-lg border border-[var(--color-arco-border)] px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-arco-ink)]"
function StocksNavigation() { return <nav aria-label="Stocks navigation" className="flex flex-wrap gap-2"><Link className={link} to={GIWA_STOCKS_ROUTE}>Stocks market data and mock trading</Link><Link className={link} to={GIWA_ADMIN_STOCKS_ROUTE}>Stocks admin view</Link></nav> }
const CAPABILITY_COPY: Readonly<Record<string, string>> = {
  READY: "Deposits and sell escrows are made from the accepted order card: confirm the order → approve the exact amount → deposit or escrow with a separate button. Each step opens the wallet only when you press its button.",
  WALLET_SOURCE_UNSUPPORTED: "The connected wallet cannot guarantee that a transaction request is sent only once, so this app does not support deposits or sell escrows with it. You can create orders, but with this wallet you can only check their status.",
  WALLET_SOURCE_MISSING: "No browser wallet is connected, so deposits and sell escrows are unavailable.",
  WALLET_NOT_CONNECTED: "No browser wallet is connected, so deposits and sell escrows are unavailable.",
  WALLET_MISMATCH: "The connected wallet is not the signed-in Stocks account, so deposits and sell escrows are unavailable.",
  SESSION_REQUIRED: "Deposits and sell escrows are available after you sign in to Stocks with the wallet that placed the order.",
  API_BASE_NOT_CONFIGURED: "The Stocks API connection is not configured correctly, so deposits and sell escrows are unavailable.",
}
function ExecutionCapabilityNote() {
  const capability = useStocksExecutionCapability()
  const code = capability === null ? "API_BASE_NOT_CONFIGURED" : capability.status === "READY" ? "READY" : capability.code
  const text = CAPABILITY_COPY[code] ?? "Checking the wallet connection for deposits and sell escrows."
  return <p className="mt-2 text-xs text-[var(--color-arco-text-soft)]" data-testid="stocks-execution-capability">{text} An accepted order, a wallet request or a transaction hash does not mean the deposit, fill or payout is complete; order results come only from the server's order status.</p>
}
function InvestorWithExecution(props: GiwaStocksFeatureProps) {
  const renderOrderExecution = useStocksOrderExecutionSlot()
  return <GiwaStocksFeature {...props} renderOrderExecution={renderOrderExecution} />
}
/** A non-NVDA detail: market data only. No order panel is opened for it and nothing is requested on its behalf. */
function ViewOnlyCard({ symbol }: { symbol: string }) {
  const id = useId()
  const demo = useDemoPresentation()
  return <section aria-labelledby={id} className="w-full min-w-0 rounded-3xl border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] p-4 sm:p-6">
    <h2 id={id} className="text-lg font-medium">{demo ? "Trade " + symbol : "View only"}</h2>
    <p role="status" className="mt-2 text-sm text-[var(--color-arco-text-soft)]">{demo ? "Trading coming soon" : `${symbol} supports market data only. Mock orders support NVDA only, and this symbol is not turned into an NVDA order.`}</p>
  </section>
}
export function StocksPage() {
  const demo = useDemoPresentation()
  const environment = useContext(StocksPageEnvironment)
  const apiBase = usePageApiBase()
  const host = useGiwaStocksHost()
  const clients = useMemo(() => {
    if (!apiBase) return { market: null, investor: null }
    try { return { market: createMarketClient(apiBase, environment.fetch), investor: createGiwaStocksHttpClient({ baseUrl: apiBase, fetch: environment.fetch }) } }
    catch { return { market: null, investor: null } }
  }, [apiBase, environment.fetch])
  const sessionId = host.snapshot.session?.id
  const invalidate = host.invalidate
  // The ID is captured in this render's callback. A late rejection cannot invalidate a newer session.
  const rejected = useCallback(() => { if (sessionId) invalidate(sessionId) }, [sessionId, invalidate])
  const session = host.snapshot.session
  // The steps before a Stocks request, for the order panel to offer (WALLET_CHANGED after a wallet switch; no address).
  const access = useStocksPageAccess()
  // Keyed siblings at one tree position: switching list ↔ detail reorders them without remounting the investor controller.
  const aside = ({ selection, unverified, quote }: StocksAsideView) => {
    const symbol = selection.symbol
    // Detail mode: only the heading above the order panel (it starts near the top of the column); the full explanation follows it.
    const explain = <><p className="mt-2 text-sm text-[var(--color-arco-text-soft)]">Testnet mock fill price: set by the server-issued quote. It uses the live NVDA price at quote time (the same source as the chart above), or 120 when the local server uses a fixed price. The market data symbol you select does not apply to this NVDA order.</p><ExecutionCapabilityNote /></>
    const trade = <section key="trade" hidden={demo && symbol !== "NVDA"} aria-label={demo ? "Trade NVDA" : "NVDA testnet mock trading"} className={demo ? "w-full min-w-0" : "w-full min-w-0 rounded-3xl border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] [&>:last-child]:rounded-b-3xl"}>
      {/* Detail mode: a compact label only — the panel below carries its own "Trade NVDA" heading, and the next-step button
          has to fit in the first screen. The list keeps the full header, where the explanation belongs above the panel. */}
      <DemoDetails><div className={`border-b border-[var(--color-arco-border)] ${symbol === null ? "p-4 sm:p-6" : "px-4 py-3 sm:px-6"}`}><h2 className={symbol === null ? "text-lg font-medium" : "text-sm font-medium"}>NVDA · testnet mock trading</h2>{symbol === null ? explain : null}</div></DemoDetails>
      <InvestorWithExecution client={clients.investor} session={host.investor} hostWallet={session ? { address: session.walletAddress, chainId: session.chainId } : null} onSessionRejected={rejected} access={access} marketPrice={quote?.symbol === "NVDA" ? quote.price : null} detailOpen={symbol === "NVDA"} onDetailChange={open => { if (open) selection.openDetail("NVDA", "investor"); else selection.closeDetail() }} />
      {!demo && symbol !== null ? <div className="border-t border-[var(--color-arco-border)] p-4 sm:p-6">{explain}</div> : null}
    </section>
    const signInRegion = <div hidden={demo} key="sign-in" className="min-w-0 empty:hidden"><StocksSignIn /></div>
    const notice = <div key="session-notice" className="min-w-0 empty:hidden"><StocksExecutionSessionNotice /></div>
    if (symbol === null) return [signInRegion, notice, trade]
    return [symbol !== "NVDA" && !unverified ? demo ? <StockMarketInvestPanel key={symbol} symbol={symbol} quote={quote ?? null} access={access} /> : <ViewOnlyCard key="view-only" symbol={symbol} /> : null, trade, signInRegion, notice]
  }
  return <StocksExecutionProvider apiBase={apiBase} fetch={environment.fetch as typeof globalThis.fetch | undefined} clock={environment.executionClock} activeSource={environment.activeWalletSource} knownHashes={environment.knownHashes}>
    <div className="w-full min-w-0 space-y-6"><DemoDetails><StocksNavigation /></DemoDetails><StocksDemoMarketNotice /><StocksMarketFeature client={clients.market} ordersClient={clients.investor} aside={aside} /></div>
  </StocksExecutionProvider>
}
/**
 * The operator sign-in shortcut is offered while the shared host can sign in, and stays while that sign-in is pending (a second
 * press joins the same attempt), so a keyboard user keeps focus on it. StocksSignIn above states why sign-in is impossible.
 */
export function StocksAdminPage() {
  const environment = useContext(StocksPageEnvironment); const host = useGiwaStocksHost(); const apiBase = usePageApiBase()
  // Trading control (003F) uses the same signed session, API base and transport as the read-only console below it.
  const onSignInRequired = host.canSignIn || host.snapshot.status === "signing-in" ? () => { void host.signIn() } : undefined
  return <div className="w-full min-w-0 space-y-6"><StocksNavigation /><StocksSignIn />{apiBase ? <><GiwaStocksTradingControlFeature apiBase={apiBase} session={host.admin} fetch={environment.fetch} onSignInRequired={onSignInRequired} /><GiwaStocksAdminFeature apiBase={apiBase} session={host.admin} fetch={environment.fetch} onSignInRequired={onSignInRequired} /></> : <><h1 className="sr-only">Stocks operations</h1><p role="status">Stocks admin API is not connected yet</p></>}</div>
}

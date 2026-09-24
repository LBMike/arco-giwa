import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react"
import { Link } from "react-router-dom"
import { GIWA_STOCKS_ROUTE } from "../routes"
import { StocksSignIn } from "../stocks-host/StocksSignIn"
import { useGiwaStocksHost } from "../stocks-host/StocksHostProvider"
import { useStocksWalletCommands } from "../stocks-host/wallet-commands"
import { actionsFor } from "../stocks-investor/actions"
import { createGiwaStocksHttpClient } from "../stocks-investor/client"
import { createStocksInvestorController, type StocksInvestorContext } from "../stocks-investor/controller"
import { PortfolioView } from "../stocks-investor/StocksViews"
import { BUTTON_SECONDARY, Notice } from "../stocks-investor/ui"
import { StocksPageEnvironment, usePageApiBase } from "../stocks-market/environment"

const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect

/** Read-only surface over the same session/controller as trading; it never creates an order. */
export function StocksPortfolioPanel({ pollMs = 10_000, ...context }: StocksInvestorContext & { pollMs?: number }) {
  const [controller] = useState(() => createStocksInvestorController())
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const actions = useMemo(() => actionsFor(controller), [controller])
  // Hide a prior identity during render, before the effect retires its in-flight requests.
  const switching = controller.identityFor(context) !== state.identityKey
  useBeforePaint(() => { controller.setContext(context) })
  useEffect(() => () => controller.suspend(), [controller])
  const ready = !switching && state.session.status === "verified" && !state.authRejected && state.catalog.status === "ready"

  useEffect(() => {
    if (ready && state.portfolio.status === "idle") actions.loadPortfolio()
  }, [ready, state.portfolio.status, state.generation, actions])

  useEffect(() => {
    if (!ready) return
    const refresh = () => {
      if (document.visibilityState === "hidden" || controller.getState().portfolio.status === "loading") return
      actions.loadPortfolio()
    }
    const timer = pollMs > 0 ? window.setInterval(refresh, pollMs) : null
    document.addEventListener("visibilitychange", refresh)
    window.addEventListener("pageshow", refresh)
    return () => {
      if (timer !== null) window.clearInterval(timer)
      document.removeEventListener("visibilitychange", refresh)
      window.removeEventListener("pageshow", refresh)
    }
  }, [ready, pollMs, state.generation, controller, actions])

  if (switching) return <Notice tone="info">Updating Stocks session…</Notice>
  // PortfolioView's catalog retry points at its original Stocks tab; offer the retry here.
  if (state.catalog.status === "error") return (
    <Notice tone="error" title="Stocks holdings could not be loaded">
      <p>Stocks information is unavailable. Your balance has not been confirmed.</p>
      <button type="button" className={`${BUTTON_SECONDARY} mt-3`} onClick={actions.retryCatalog}>Retry Stocks connection</button>
    </Notice>
  )
  return <PortfolioView state={state} actions={actions} />
}

export function StocksPortfolioSection() {
  const environment = useContext(StocksPageEnvironment)
  const apiBase = usePageApiBase()
  const host = useGiwaStocksHost()
  const commands = useStocksWalletCommands()
  const client = useMemo(() => {
    if (!apiBase) return null
    try { return createGiwaStocksHttpClient({ baseUrl: apiBase, fetch: environment.fetch }) }
    catch { return null }
  }, [apiBase, environment.fetch])
  const sessionId = host.snapshot.session?.id
  const invalidate = host.invalidate
  // A late 401 belongs to the captured session, never a later sign-in.
  const rejected = useCallback(() => { if (sessionId) invalidate(sessionId) }, [sessionId, invalidate])
  return (
    <section aria-label="Stocks portfolio" className="w-full min-w-0 space-y-4" data-testid="stocks-portfolio-section">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--color-arco-text-soft)]">Stocks are shown in units and excluded from Savings &amp; Funds valuations.</p>
        <Link to={GIWA_STOCKS_ROUTE} className={BUTTON_SECONDARY}>Trade Stocks</Link>
      </div>
      <StocksSignIn />
      {host.walletStatus === "wrong-network" && commands?.switchNetwork ? (
        <button type="button" className={BUTTON_SECONDARY} onClick={commands.switchNetwork}>Switch to GIWA Sepolia</button>
      ) : null}
      {host.walletStatus === "disconnected" && commands?.connect ? (
        <button type="button" className={BUTTON_SECONDARY} onClick={commands.connect}>Connect wallet for Stocks</button>
      ) : null}
      <StocksPortfolioPanel client={client} session={host.investor} hostWallet={{ address: host.wallet.address, chainId: host.wallet.chainId }} onSessionRejected={rejected} />
    </section>
  )
}

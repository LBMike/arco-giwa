import { useCallback, useEffect, useRef, useState } from "react"
import { useStocksFundingReadContext } from "../stocks-execution-host/StocksExecutionProvider"
import type { ExecutionHostView } from "../stocks-execution-host/registry"
import { createStocksExecutionReads } from "../stocks-wallet-http"
import { useDemoPresentation } from "../demo-presentation"
import { formatCash } from "./display"
import { platformFundingRpc, platformWalletCashRpc, readTusdcFunding, readWalletTusdc, type FundingRead, type WalletCashRead, type WalletCashRpc, type WalletStockScope } from "./funding-read"
import { FOCUS_RING } from "./ui"

export function sameFundingScope(first: ExecutionHostView, next: ExecutionHostView, now: number): boolean {
  const a = first.session, b = next.session
  return Boolean(a && b && first.apiBase && first.apiBase === next.apiBase && a.id === b.id && a.accessToken === b.accessToken
    && a.walletAddress.toLowerCase() === b.walletAddress.toLowerCase() && a.chainId === 91342 && b.chainId === 91342
    && a.expiresAt > now && b.expiresAt > now
    && first.wallet.address?.toLowerCase() === a.walletAddress.toLowerCase() && next.wallet.address?.toLowerCase() === b.walletAddress.toLowerCase()
    && first.wallet.chainId === 91342 && next.wallet.chainId === 91342 && first.wallet.epoch === next.wallet.epoch && first.wallet.source === next.wallet.source)
}
type FundingState = { key: string; scope: ExecutionHostView; status: "loading" | "ready" | "error"; data: FundingRead | null }

/** What the verified funding read shows: signed out (no session), loading, ready or failed. */
export type FundingStatus = { status: "signed-out" | "loading" | "ready" | "error"; data: FundingRead | null; refresh: () => void }

/** No session: nothing verified to read (direct trades read the wallet only). */
export const SIGNED_OUT_FUNDING: FundingStatus = Object.freeze({ status: "signed-out" as const, data: null, refresh: () => undefined })

/** Same identity as the execution host, but read-only and never an execution permission. */
export function useStocksFundingStatus(deploymentId: string | null): FundingStatus {
  const context = useStocksFundingReadContext()
  const live = useRef(context)
  live.current = context
  const view = context?.view
  const enabled = Boolean(deploymentId && view && sameFundingScope(view, view, context?.clock?.now() ?? Date.now()))
  const key = enabled && view ? JSON.stringify([deploymentId, view.apiBase, view.session?.id, view.wallet.address, view.wallet.chainId, view.wallet.epoch]) : null
  const [held, setHeld] = useState<FundingState | null>(null)
  const flight = useRef<AbortController | null>(null)
  const refresh = useCallback(() => {
    const host = live.current
    if (key === null || !deploymentId || !host?.view.session || !host.view.apiBase) return
    flight.current?.abort()
    const abort = new AbortController()
    flight.current = abort
    const captured = host.view
    const session = captured.session!
    const now = host.clock?.now ?? Date.now
    const current = () => flight.current === abort && !abort.signal.aborted && Boolean(live.current && live.current.fetch === host.fetch && live.current.clock === host.clock && sameFundingScope(captured, live.current.currentView(), now()))
    if (!current()) return
    setHeld({ key, scope: captured, status: "loading", data: null })
    const timer = setTimeout(() => {
      if (!current()) return
      abort.abort()
      setHeld(value => value?.key === key ? { key, scope: captured, status: "error", data: null } : value)
    }, 10_000)
    void (async () => {
      try {
        const reads = createStocksExecutionReads({ apiBase: captured.apiBase!, fetch: host.fetch, now, monotonicNow: host.clock?.monotonicNow })
        const lease = await reads.readDeployment({ apiBase: captured.apiBase!, token: session.accessToken, sessionId: session.id, signal: abort.signal })
        if (!current() || lease.deployment.manifest.deploymentId !== deploymentId || lease.deployment.manifest.schemaVersion !== 3) throw Error("UNVERIFIED_CASH")
        const data = await readTusdcFunding({ deployment: lease.deployment, wallet: session.walletAddress, rpc: platformFundingRpc, current: () => current() && reads.currentDeployment(lease) !== null, now })
        if (current()) setHeld({ key, scope: captured, status: "ready", data })
      } catch {
        if (current()) setHeld({ key, scope: captured, status: "error", data: null })
      } finally { clearTimeout(timer) }
    })()
  }, [key, deploymentId, context?.fetch, context?.clock, view?.wallet.source, view?.session?.accessToken])
  useEffect(() => { refresh(); return () => flight.current?.abort() }, [refresh])
  // Render-time binding: never show A's result during B's render while effect cleanup is pending.
  const visible = key !== null && held?.key === key && view && sameFundingScope(held.scope, view, context?.clock?.now() ?? Date.now()) ? held : null
  return { status: key === null ? "signed-out" as const : visible?.status ?? "loading" as const, data: visible?.data ?? null, refresh }
}

/** How often an open panel reads the wallet's tUSDC again. It also reads again when the tab becomes visible. */
export const WALLET_CASH_REFRESH_MS = 20_000
type WalletCashState = { key: string; address: string; status: "loading" | "ready" | "error"; data: WalletCashRead | null }
export type WalletCashStatus = { status: "unavailable" | "loading" | "ready" | "error"; data: WalletCashRead | null; refresh: () => void }

/** The last wallet read per address: the investor view swaps the panel out while a session starts, and a remount must not blank the balance. */
const lastWalletCash = new Map<string, WalletCashRead>()

/**
 * The connected wallet's tUSDC, shown before and after Stocks sign-in (the Funds panel does the same). Keyed by the
 * wallet address on chain 91342, so signing in, a new session or a new wallet client never hides it. With `spender`
 * (the verified deployment's funding vault, known after sign-in) it also reads the allowance given to that vault.
 * Display and pre-quote approval only: execution's own fresh checks stay the authority for trading.
 */
export function useStocksWalletCash(enabled: boolean, spender: string | null = null, rpc: WalletCashRpc = platformWalletCashRpc, refreshMs = WALLET_CASH_REFRESH_MS, stock: WalletStockScope | null = null, gas = false): WalletCashStatus {
  const wallet = useStocksFundingReadContext()?.view.wallet
  const address = enabled && wallet?.address && wallet.chainId === 91342 ? wallet.address.toLowerCase() : null
  const vault = spender ? spender.toLowerCase() : null
  const stockToken = stock ? stock.token.toLowerCase() : null
  const escrow = stock ? stock.spender.toLowerCase() : null
  const key = address === null ? null : JSON.stringify([address, vault, stockToken, escrow, gas])
  const live = useRef(key)
  live.current = key
  const [held, setHeld] = useState<WalletCashState | null>(() => {
    const cached = address === null ? undefined : lastWalletCash.get(address)
    return cached && key !== null && address !== null ? { key, address, status: "ready", data: cached } : null
  })
  const flight = useRef<AbortController | null>(null)
  const refresh = useCallback(() => {
    if (key === null || address === null) return
    flight.current?.abort()
    const abort = new AbortController()
    flight.current = abort
    const current = () => flight.current === abort && !abort.signal.aborted && live.current === key
    // A re-read keeps this wallet's last balance on screen (also while the vault's allowance is added); another wallet starts from "--".
    const failed = (value: WalletCashState | null): WalletCashState => value?.address === address && value.data ? { ...value, key } : { key, address, status: "error", data: null }
    setHeld(value => value?.address === address ? { ...value, key } : { key, address, status: lastWalletCash.has(address) ? "ready" : "loading", data: lastWalletCash.get(address) ?? null })
    const timer = setTimeout(() => { if (current()) { abort.abort(); setHeld(failed) } }, 10_000)
    readWalletTusdc({ wallet: address, rpc, current, spender: vault, stock: stockToken && escrow ? { token: stockToken, spender: escrow } : null, gas })
      .then(data => { if (current()) { lastWalletCash.set(address, data); setHeld({ key, address, status: "ready", data }) } }, () => { if (current()) setHeld(failed) })
      .finally(() => clearTimeout(timer))
  }, [key, address, vault, stockToken, escrow, rpc, gas])
  useEffect(() => {
    if (key === null) return
    refresh()
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") refresh() }, refreshMs)
    const onVisible = () => { if (document.visibilityState === "visible") refresh() }
    document.addEventListener("visibilitychange", onVisible)
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); flight.current?.abort() }
  }, [key, refresh, refreshMs])
  const visible = address !== null && held?.address === address ? held : null
  return { status: key === null ? "unavailable" : visible?.status ?? "loading", data: visible?.data ?? null, refresh }
}

export function faucetMessage(data: FundingRead): string {
  switch (data.faucet.status) {
    case "AVAILABLE": return `Use Mint test assets for ${formatCash(data.faucet.amount!)} USDC. Availability is checked again when you mint.`
    case "COOLDOWN": {
      if (data.faucet.remainingSeconds === null) return "The faucet cooldown has not ended."
      const seconds = BigInt(data.faucet.remainingSeconds)
      return `Mint cooldown: ${seconds / 3600n}h ${seconds % 3600n / 60n}m ${seconds % 60n}s remaining at the last balance check.`
    }
    case "DAILY_CAP": return "The faucet's daily USDC limit has been reached."
    case "TOTAL_CAP": return "The faucet's total USDC limit has been reached."
    case "PAUSED": return "Mint test assets is paused."
    case "DISABLED": return "USDC minting is disabled."
    default: return "Faucet availability could not be checked. Use Mint test assets to check in your wallet."
  }
}

export function StocksFundingStatus({ funding, wallet, requiredCash }: { funding: FundingStatus; wallet?: WalletCashStatus; requiredCash: string | null }) {
  // The customer presentation says only what the wallet must do (no gas yet); the technical preview keeps every check.
  const demo = useDemoPresentation()
  const { data, status } = funding
  const walletCash = wallet?.data ?? null
  const walletStatus = wallet?.status ?? "unavailable"
  // The balance on screen: the wallet's head-block read when there is one, otherwise the verified (finalized) read.
  const balance = walletCash?.balance ?? data?.balance ?? null
  const insufficient = balance !== null && requiredCash !== null && BigInt(balance) < BigInt(requiredCash)
  const gas = data?.gas ?? walletCash?.gas ?? null
  const refresh = () => { funding.refresh(); wallet?.refresh() }
  if (demo) return <div className="mt-2 flex flex-col gap-1 text-xs leading-5 text-[var(--color-arco-text-soft)]" data-testid="stocks-funding-status">
    {status === "signed-out" && walletStatus === "unavailable" ? <p>Connect a wallet on GIWA Sepolia to see its USDC balance.</p> : null}
    {walletStatus === "error" && walletCash === null ? <p>USDC balance could not be read from GIWA. Refresh to try again.</p> : null}
    {walletCash?.balance === "0" && !insufficient ? <p>This wallet has no USDC yet. Use Mint test assets to get test cash.</p> : null}
    {insufficient ? <p>Not enough USDC for this amount. Use Mint test assets, then refresh the balance.</p> : null}
    {gas === "0" ? <p>Add GIWA test ETH to this wallet for transaction gas.</p> : null}
    {status !== "signed-out" || walletStatus === "ready" || walletStatus === "error" ? <button type="button" onClick={refresh} disabled={status === "loading"} className={`${FOCUS_RING} self-start underline disabled:cursor-wait`}>
      Refresh balance
    </button> : null}
  </div>
  return <div className="mt-2 flex flex-col gap-1 text-xs leading-5 text-[var(--color-arco-text-soft)]" data-testid="stocks-funding-status">
    {status === "signed-out" && walletStatus === "unavailable" ? <p>Connect a wallet on GIWA Sepolia to see its USDC balance.</p> : null}
    {walletStatus === "error" && walletCash === null ? <p>USDC balance could not be read from GIWA. Refresh to try again.</p> : null}
    {walletCash?.balance === "0" && !insufficient ? <p>This wallet has no USDC yet. Use Mint test assets to get test cash.</p> : null}
    {status === "loading" ? <p>Checking test cash and gas…</p> : null}
    {status === "error" ? <p>{walletCash ? "Gas and faucet status could not be checked. Refresh to try again." : "Test cash balance could not be verified. Refresh before trading."}</p> : null}
    {insufficient ? <p>Insufficient USDC for this quote. Use Mint test assets, then refresh the balance.</p> : null}
    {data ? <>
      {data.gas === "0" ? <p>Add GIWA test ETH to this wallet for transaction gas.</p> : <p>GIWA test ETH is present. Your wallet checks the transaction gas cost.</p>}
      <p>{faucetMessage(data)}</p>
    </> : null}
    {status !== "signed-out" || walletStatus === "ready" || walletStatus === "error" ? <button type="button" onClick={refresh} disabled={status === "loading"} className={`${FOCUS_RING} self-start underline disabled:cursor-wait`}>
      Refresh balance
    </button> : null}
  </div>
}

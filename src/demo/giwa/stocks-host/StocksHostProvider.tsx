import { createContext, useContext, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react"
import type { ActiveWalletSource, WalletSourceView } from "../stocks-wallet-source/types"
import { adminSession, investorSession } from "./adapters"
import { createStocksHostSession, type HostContext, type HostDependencies, type HostSnapshot, type StocksHostController } from "./session"

const SIGNED_OUT: HostSnapshot = Object.freeze({ status: "signed-out", session: null, error: null })
const UNAVAILABLE: HostSnapshot = Object.freeze({ status: "error", session: null, error: "AUTH_UNAVAILABLE" })
const subscribeNothing = () => () => {}
const readSignedOut = () => SIGNED_OUT

type Owner = { key: string; dependencies: HostDependencies; controller: StocksHostController | null }
export type StocksHostValue = {
  snapshot: HostSnapshot
  investor: ReturnType<typeof investorSession>
  admin: ReturnType<typeof adminSession>
  canSignIn: boolean
  walletStatus: "disconnected" | "wrong-network" | "unavailable" | "ready"
  /** The host's active wallet view: address, chain, connection epoch and the provider tree's active source object. */
  wallet: WalletSourceView
  signIn(): Promise<void>
  logout(): void
  /** Capture the request's session ID before sending it. Never read a new ID after a 401. */
  invalidate(sessionId: string): void
}
const StocksHostContext = createContext<StocksHostValue | null>(null)

/** One owner above route navigation. Each committed scope gets a fresh in-memory controller. */
export function StocksHostProvider({ context, dependencies, signingReady = true, walletSource = null, children }: {
  context: HostContext
  dependencies: HostDependencies
  signingReady?: boolean
  /** The wallet provider tree's active source (injected provider or Dynamic client). Never used to sign in here. */
  walletSource?: ActiveWalletSource | null
  children: ReactNode
}) {
  const key = JSON.stringify([context.walletAddress?.toLowerCase() ?? null, context.chainId, context.frontendOrigin, context.apiBase, context.walletEpoch ?? "", signingReady])
  const [owner, setOwner] = useState<Owner | null>(null)
  // This check is during render, BEFORE the effect which retires the old owner.
  // In particular A→B, API changes and source replacement cannot paint A's token.
  const current = owner?.key === key && owner.dependencies === dependencies ? owner : null
  const controller = current?.controller ?? null
  const snapshot = useSyncExternalStore(controller?.subscribe ?? subscribeNothing, controller?.getSnapshot ?? readSignedOut, readSignedOut)

  useLayoutEffect(() => {
    let next: StocksHostController | null = null
    try { next = createStocksHostSession(context, dependencies) } catch { /* Stable public error only. */ }
    setOwner({ key, dependencies, controller: next })
    const refresh = () => next?.refresh()
    const onVisible = () => { if (document.visibilityState === "visible") refresh() }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("pageshow", refresh)
    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("pageshow", refresh)
      // StrictMode's setup→cleanup→setup creates a NEW controller on its second setup.
      next?.dispose()
    }
    // context consists exclusively of the scalar values encoded by key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, dependencies])

  const walletStatus = !context.walletAddress ? "disconnected" : context.chainId !== 91342 ? "wrong-network" : !signingReady ? "unavailable" : "ready"
  const visible = current && !controller ? UNAVAILABLE : snapshot
  const walletAddress = context.walletAddress
  const chainId = context.chainId
  const walletEpoch = context.walletEpoch ?? ""
  const wallet = useMemo<WalletSourceView>(() => Object.freeze({ source: walletSource, address: walletAddress, chainId, epoch: walletEpoch }), [walletSource, walletAddress, chainId, walletEpoch])
  const value = useMemo<StocksHostValue>(() => ({
    snapshot: visible,
    investor: investorSession(visible),
    admin: adminSession(visible),
    canSignIn: Boolean(controller && walletStatus === "ready" && visible.status !== "signing-in"),
    walletStatus,
    wallet,
    async signIn() { if (walletStatus === "ready") await controller?.signIn() },
    logout() { controller?.logout() },
    invalidate(sessionId) { controller?.invalidate(sessionId) },
  }), [controller, visible, walletStatus, wallet])
  return <StocksHostContext.Provider value={value}>{children}</StocksHostContext.Provider>
}

export function useGiwaStocksHost() {
  const value = useContext(StocksHostContext)
  if (!value) throw new Error("useGiwaStocksHost must be used inside StocksHostProvider")
  return value
}

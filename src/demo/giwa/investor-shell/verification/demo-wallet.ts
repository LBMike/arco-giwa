// DEMO ONLY: the demo wallet behind the investor shell preview's ?wallet=demo. Not a wallet: no keys, no signatures,
// and nothing leaves the page. Never imported by product code.
//
// - provider: the EIP-1193 object the app finds as window.ethereum (the app's injected-wallet path). Connecting and
//   sending wait for Confirm or Reject in the demo wallet window (DemoWalletPanel), or confirm themselves when
//   auto-confirm is on. Reads go straight to the demo chain.
// - rpc: the demo chain's JSON-RPC endpoint; the preview's fetch guard answers GIWA RPC requests from it.
// - The chain, the connection and auto-confirm last for the browser tab (sessionStorage) until Reset.

import { getAddress, type Address } from "viem"
import type { GiwaRedemption } from "../../types"
import { DEMO_CHAIN_ID, DemoChain, DemoRpcError, type DemoChainConfig, type DemoChainSave, type DemoChainView, type DemoTxDescription } from "./demo-chain"

/** The demo account ("DE30" ≈ demo). */
export const DEMO_ACCOUNT = getAddress("0xde30de30de30de30de30de30de30de30de30de30")
const STORAGE_KEY = "giwa-investor-shell-preview:demo-wallet:v1"
const AUTO_CONFIRM_MS = 900
const CHAIN_HEX = `0x${DEMO_CHAIN_ID.toString(16)}`

export type DemoPrompt = Readonly<{
  id: number
  kind: "connect" | "transaction"
  title: string
  detail: string | null
  rows: readonly (readonly [string, string])[]
}>
export type DemoWalletView = Readonly<{
  account: Address
  connected: boolean
  autoConfirm: boolean
  /** The request on show, oldest first. */
  prompt: DemoPrompt | null
  /** Requests queued behind it. */
  waiting: number
  chain: DemoChainView
}>

type Listener = (...args: unknown[]) => void
export type DemoProvider = Readonly<{
  isDemoWallet: true
  request: <T = unknown>(args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<T>
  on: (event: string, listener: Listener) => void
  removeListener: (event: string, listener: Listener) => void
}>

export type DemoWallet = Readonly<{
  provider: DemoProvider
  /** A GIWA RPC request body in, the demo chain's response body out. */
  rpc: (body: string) => string
  /** The indexer's redemptions answer for the demo account; null for any other wallet. */
  redemptions: (wallet: string) => GiwaRedemption[] | null
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => DemoWalletView
  confirm: (id: number) => void
  reject: (id: number) => void
  setAutoConfirm: (on: boolean) => void
  reset: () => void
}>

type Pending = DemoPrompt & Readonly<{ resolve: () => void; reject: (error: DemoRpcError) => void }>
type Saved = Readonly<{ chain: DemoChainSave; connected: boolean; autoConfirm: boolean }>

function readSaved(storage: Storage | null): Saved | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (!raw) return null
    const saved = JSON.parse(raw) as Saved
    return saved?.chain?.v === 1 ? saved : null
  } catch {
    return null
  }
}

function userRejected(): DemoRpcError {
  return new DemoRpcError(4001, "User rejected the request.")
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function createDemoWallet(config: DemoChainConfig, storage: Storage | null): DemoWallet {
  const saved = readSaved(storage)
  let chain = new DemoChain(config, saved?.chain ?? null)
  let connected = saved?.connected ?? false
  let autoConfirm = saved?.autoConfirm ?? false
  let queue: Pending[] = []
  let nextId = 1
  const listeners = new Set<() => void>()
  const events = new Map<string, Set<Listener>>()
  let snapshot = build()

  function build(): DemoWalletView {
    const head = queue[0]
    return {
      account: chain.account,
      connected,
      autoConfirm,
      prompt: head ? { id: head.id, kind: head.kind, title: head.title, detail: head.detail, rows: head.rows } : null,
      waiting: Math.max(0, queue.length - 1),
      chain: chain.view(),
    }
  }

  function changed() {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify({ chain: chain.save(), connected, autoConfirm } satisfies Saved))
    } catch {
      // Storage unavailable: the demo lasts until reload.
    }
    snapshot = build()
    listeners.forEach((listener) => listener())
  }

  function emit(event: string, ...args: unknown[]) {
    events.get(event)?.forEach((listener) => {
      try {
        listener(...args)
      } catch {
        // A page listener's error is the page's own.
      }
    })
  }

  function settle(id: number, ok: boolean) {
    const entry = queue.find((pending) => pending.id === id)
    if (!entry) return
    queue = queue.filter((pending) => pending.id !== id)
    if (ok) entry.resolve()
    else entry.reject(userRejected())
    changed()
  }

  function confirmLater(id: number) {
    setTimeout(() => {
      if (autoConfirm) settle(id, true)
    }, AUTO_CONFIRM_MS)
  }

  /** Shows a request in the demo wallet window and waits for Confirm (resolves) or Reject (throws 4001). */
  function ask(kind: DemoPrompt["kind"], text: DemoTxDescription): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const id = nextId
      nextId += 1
      queue = [...queue, { id, kind, title: text.title, detail: text.detail, rows: text.rows, resolve, reject }]
      changed()
      if (autoConfirm) confirmLater(id)
    })
  }

  async function request(method: string, params: readonly unknown[]): Promise<unknown> {
    switch (method) {
      case "eth_requestAccounts":
        if (!connected) {
          const site = typeof window === "undefined" ? null : window.location.host
          await ask("connect", {
            title: "Connect to Arco",
            detail: site,
            rows: [
              ["Account", shortAddress(chain.account)],
              ["Network", "GIWA Sepolia"],
            ],
          })
          connected = true
          changed()
        }
        return [chain.account]
      case "eth_accounts":
        return connected ? [chain.account] : []
      case "eth_chainId":
        return CHAIN_HEX
      case "net_version":
        return String(DEMO_CHAIN_ID)
      case "wallet_switchEthereumChain": {
        const wanted = (params[0] as { chainId?: unknown } | undefined)?.chainId
        if (typeof wanted === "string" && wanted.toLowerCase() === CHAIN_HEX) return null
        throw new DemoRpcError(4902, "The demo wallet only knows GIWA Sepolia")
      }
      case "wallet_addEthereumChain":
        return null
      case "eth_sendTransaction": {
        if (!connected) throw new DemoRpcError(4100, "Connect the demo wallet first")
        const tx = params[0]
        await ask("transaction", chain.describe(tx))
        const hash = chain.send(tx)
        changed()
        return hash
      }
      case "personal_sign":
      case "eth_sign":
      case "eth_signTypedData_v4":
        throw new DemoRpcError(4200, "The demo wallet does not sign messages")
      default:
        return chain.handle(method, params)
    }
  }

  const provider: DemoProvider = {
    isDemoWallet: true,
    request: async <T,>({ method, params }: { method: string; params?: unknown[] | Record<string, unknown> }) =>
      (await request(method, Array.isArray(params) ? params : [])) as T,
    on: (event, listener) => {
      const set = events.get(event) ?? new Set<Listener>()
      set.add(listener)
      events.set(event, set)
    },
    removeListener: (event, listener) => {
      events.get(event)?.delete(listener)
    },
  }

  return {
    provider,
    rpc: (body) => chain.respond(body),
    redemptions: (wallet) => chain.redemptionsOf(wallet),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    confirm: (id) => settle(id, true),
    reject: (id) => settle(id, false),
    setAutoConfirm: (on) => {
      autoConfirm = on
      changed()
      if (on) queue.forEach((pending) => confirmLater(pending.id))
    },
    reset: () => {
      const dropped = queue
      queue = []
      dropped.forEach((pending) => pending.reject(userRejected()))
      try {
        storage?.removeItem(STORAGE_KEY)
      } catch {
        // Storage unavailable: nothing was kept.
      }
      const wasConnected = connected
      chain = new DemoChain(config, null)
      connected = false
      changed()
      // The page drops the account, as it does when a real wallet disconnects.
      if (wasConnected) emit("accountsChanged", [])
    },
  }
}

/** Makes the demo provider the page's window.ethereum. */
export function installDemoProvider(provider: DemoProvider): void {
  try {
    Object.defineProperty(window, "ethereum", { value: provider, configurable: true, writable: true })
  } catch {
    ;(window as unknown as { ethereum: unknown }).ethereum = provider
  }
}

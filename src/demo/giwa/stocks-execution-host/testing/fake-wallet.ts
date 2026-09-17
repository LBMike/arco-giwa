// TEST FIXTURE ONLY. Never import this module from product code.
//
// A scriptable EIP-1193 provider backed by the fake chain. It supports only eth_chainId, eth_accounts,
// eth_getBlockByNumber, eth_call and eth_sendTransaction; every other method is recorded and rejected with 4200.
// request() records the call and runs hooks synchronously, before returning its promise. No key, no signing.

import type { ChainTransactionRequest, FakeChain, NetworkVariant } from "./fake-chain"

export type WalletCall = Readonly<{ method: string; params: unknown; at: number }>
export type WalletRequest = { method: string; params?: unknown }
export type WalletListener = (...args: unknown[]) => void
export type HeldRequest = {
  /** Resolves once the held call has arrived. */
  readonly arrived: Promise<void>
  /**
   * With no argument: answers now (a held eth_sendTransaction is applied to the chain now and resolves its hash).
   * With a value: resolves exactly that value; a held eth_sendTransaction is then NOT applied unless apply() ran.
   */
  release(result?: unknown): void
  reject(error: unknown): void
  /** eth_sendTransaction only: applies the held transaction now and returns its hash without resolving. */
  apply(): string
}

const SUPPORTED = new Set(["eth_chainId", "eth_accounts", "eth_getBlockByNumber", "eth_call", "eth_sendTransaction"])

export function providerError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code })
}

type Pending = { method: string; params: unknown; network: NetworkVariant; resolve(value: unknown): void; reject(error: unknown): void }
type Hold = HeldRequest & { attach(pending: Pending): void }

export function createFakeEip1193Wallet(chain: FakeChain, options: { account: string | null; network?: NetworkVariant; now?: () => number }) {
  const now = options.now ?? Date.now
  let account = options.account
  let network: NetworkVariant = options.network ?? "reviewed"
  let disconnected = false
  const calls: WalletCall[] = []
  const listeners = new Map<string, Set<WalletListener>>()
  const hooks = new Map<string, Set<(call: WalletCall) => void>>()
  const failures = new Map<string, unknown[]>()
  const answers = new Map<string, unknown[]>()
  const holds = new Map<string, Hold[]>()

  const queue = <T>(map: Map<string, T[]>, method: string) => { let list = map.get(method); if (!list) map.set(method, list = []); return list }
  const take = <T>(map: Map<string, T[]>, method: string): { found: boolean; value?: T } => {
    const list = map.get(method)
    return list && list.length > 0 ? { found: true, value: list.shift() } : { found: false }
  }

  function emit(event: string, ...args: unknown[]) {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
  }

  function transactionRequest(params: unknown): ChainTransactionRequest {
    const tx = Array.isArray(params) && params.length === 1 ? params[0] : null
    if (tx === null || typeof tx !== "object") throw providerError(-32602, "Invalid params")
    const { from, to, data, value } = tx as Record<string, unknown>
    if (typeof from !== "string" || typeof to !== "string" || typeof data !== "string" || (value !== undefined && typeof value !== "string")) throw providerError(-32602, "Invalid params")
    if (account === null || from.toLowerCase() !== account.toLowerCase()) throw providerError(4100, "The requested account has not been authorized")
    return { from, to, data, ...(value === undefined ? {} : { value }) }
  }

  /** The wallet's own answer at this moment. Throws provider errors. */
  function answer(method: string, params: unknown, view: NetworkVariant): unknown {
    if (!SUPPORTED.has(method)) throw providerError(4200, "Unsupported method")
    if (disconnected) throw providerError(4900, "Disconnected")
    if (method === "eth_accounts") return account === null ? [] : [account]
    if (method === "eth_sendTransaction") return chain.sendTransaction(transactionRequest(params), view)
    return chain.answer(view, method, Array.isArray(params) ? params : [])
  }

  function request(input: WalletRequest): Promise<unknown> {
    const method = String(input?.method)
    const params = input?.params
    const call: WalletCall = Object.freeze({ method, params: params === undefined ? undefined : structuredClone(params), at: now() })
    calls.push(call)
    try {
      for (const hook of [...(hooks.get(method) ?? [])]) hook(call)
      const failure = take(failures, method)
      if (failure.found) return Promise.reject(failure.value)
      const scripted = take(answers, method)
      if (scripted.found) return Promise.resolve(scripted.value)
      if (!SUPPORTED.has(method)) throw providerError(4200, "Unsupported method")
      // A transaction prompt is validated when requested; a held one is applied on release.
      if (method === "eth_sendTransaction") transactionRequest(params)
      const hold = take(holds, method)
      if (hold.found) {
        const view = network
        return new Promise((resolve, reject) => hold.value!.attach({ method, params, network: view, resolve, reject }))
      }
      return Promise.resolve(answer(method, params, network))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  function createHold(method: string): Hold {
    let pending: Pending | null = null
    let settled = false
    let appliedHash: string | null = null
    let markArrived!: () => void
    const arrived = new Promise<void>((resolve) => { markArrived = resolve })
    const ready = () => {
      if (!pending) throw new Error("HOLD_NOT_ARRIVED")
      if (settled) throw new Error("HOLD_ALREADY_SETTLED")
      return pending
    }
    return {
      arrived,
      attach(value) { pending = value; markArrived() },
      apply() {
        const held = ready()
        if (method !== "eth_sendTransaction") throw new Error("HOLD_APPLY_SEND_ONLY")
        if (appliedHash === null) appliedHash = chain.sendTransaction(transactionRequest(held.params), held.network)
        return appliedHash
      },
      release(...args: unknown[]) {
        const held = ready()
        settled = true
        if (args.length > 0) return held.resolve(args[0])
        if (appliedHash !== null) return held.resolve(appliedHash)
        try {
          held.resolve(method === "eth_sendTransaction" ? chain.sendTransaction(transactionRequest(held.params), held.network) : answer(method, held.params, held.network))
        } catch (error) {
          held.reject(error)
        }
      },
      reject(error) {
        const held = ready()
        settled = true
        held.reject(error)
      },
    }
  }

  const provider = {
    request,
    on(event: string, listener: WalletListener) {
      let set = listeners.get(event)
      if (!set) listeners.set(event, set = new Set())
      set.add(listener)
      return provider
    },
    removeListener(event: string, listener: WalletListener) {
      listeners.get(event)?.delete(listener)
      return provider
    },
  }

  return Object.assign(provider, {
    get calls(): readonly WalletCall[] { return calls },
    callsOf: (method: string) => calls.filter((call) => call.method === method),
    get account() { return account },
    get network() { return network },
    holdNext(method: string): HeldRequest {
      const hold = createHold(method)
      queue(holds, method).push(hold)
      return hold
    },
    failNext(method: string, error: unknown) { queue(failures, method).push(error) },
    answerNext(method: string, value: unknown) { queue(answers, method).push(value) },
    /** Runs synchronously for every matching call before it is answered. Returns an unsubscribe function. */
    onCall(method: string, hook: (call: WalletCall) => void) {
      let set = hooks.get(method)
      if (!set) hooks.set(method, set = new Set())
      set.add(hook)
      return () => { set!.delete(hook) }
    },
    setAccount(address: string | null) {
      account = address
      emit("accountsChanged", address === null ? [] : [address])
    },
    setNetwork(variant: NetworkVariant) {
      network = variant
      emit("chainChanged", chain.answer(variant, "eth_chainId"))
    },
    disconnect() {
      disconnected = true
      emit("disconnect", providerError(4900, "Disconnected"))
    },
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
  })
}

export type FakeEip1193Wallet = ReturnType<typeof createFakeEip1193Wallet>

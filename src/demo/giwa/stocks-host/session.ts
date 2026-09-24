import { createSiweMessage } from "viem/siwe"
import { getAddress, isAddress, type Address } from "viem"
import { resolveApiBase } from "../api-base"

export type HostContext = {
  walletAddress: string | null
  chainId: number | null
  frontendOrigin: string
  apiBase: string
  /** Changes when the host replaces its wallet connection, even for the same address. */
  walletEpoch?: string
}
export type MessageRequest = { account: Address; chainId: 91342; message: string }
export type HostSession = Readonly<{
  id: string; walletAddress: Address; chainId: 91342; accessToken: string
  createdAt: number; expiresAt: number
}>
export type HostSnapshot = Readonly<{
  status: "signed-out" | "signing-in" | "authenticated" | "error"
  session: HostSession | null
  error: string | null
}>
export type HostDependencies = {
  signMessage(request: MessageRequest): Promise<string>
  fetch?: typeof fetch
  now?: () => number
  setTimer?: (callback: () => void, delay: number) => unknown
  clearTimer?: (timer: unknown) => void
  httpTimeoutMs?: number
}
type Scope = { key: string; wallet: Address | null; chain: number | null; origin: string; domain: string; api: string }
type Attempt = { generation: number; abort: AbortController; scope: Scope; promise?: Promise<HostSession | null> }
const OUT: HostSnapshot = Object.freeze({ status: "signed-out", session: null, error: null })
class AuthError extends Error {}
function ensure(value: unknown, code: string): asserts value { if (!value) throw new AuthError(code) }
function object(value: unknown): Record<string, unknown> {
  ensure(value && typeof value === "object" && !Array.isArray(value), "INVALID_AUTH_RESPONSE")
  return value as Record<string, unknown>
}
function scopeOf(context: HostContext): Scope {
  const origin = new URL(context.frontendOrigin)
  // An empty "?" or "#" leaves url.search/url.hash empty, so the href itself is checked.
  ensure(["http:", "https:"].includes(origin.protocol) && !origin.username && !origin.password && !origin.href.includes("?") && !origin.href.includes("#"), "INVALID_AUTH_CONTEXT")
  ensure(origin.pathname === "/", "INVALID_AUTH_CONTEXT")
  const base = resolveApiBase(context.apiBase, origin.origin)
  ensure(base, "INVALID_AUTH_CONTEXT")
  const wallet = context.walletAddress === null ? null : getAddress(context.walletAddress)
  return { key: JSON.stringify([wallet, context.chainId, origin.origin, base, context.walletEpoch ?? ""]), wallet, chain: context.chainId, origin: origin.origin, domain: origin.host, api: base }
}
function jwtClaims(token: string): Record<string, unknown> {
  ensure(token.length <= 4096 && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token), "INVALID_AUTH_RESPONSE")
  const part = token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")
  const decoded = atob(part.padEnd(Math.ceil(part.length / 4) * 4, "="))
  return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(decoded, c => c.charCodeAt(0)))))
}

/** The server authenticates SIWE and every API request. This store only owns a browser session. */
export function createStocksHostSession(initial: HostContext, dependencies: HostDependencies) {
  const transport = dependencies.fetch ?? globalThis.fetch
  const now = dependencies.now ?? Date.now
  const setTimer = dependencies.setTimer ?? ((cb, delay) => setTimeout(cb, delay))
  const clearTimer = dependencies.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const timeout = dependencies.httpTimeoutMs ?? 15_000
  ensure(Number.isFinite(timeout) && timeout > 0 && timeout <= 60_000, "INVALID_AUTH_TIMEOUT")
  let scope = scopeOf(initial)
  let generation = 0
  let disposed = false
  let invalidContext = false
  let snapshot = OUT
  let active: Attempt | null = null
  let expiryTimer: unknown
  const instanceId = globalThis.crypto.randomUUID()
  const listeners = new Set<() => void>()
  function publish(next: HostSnapshot) { snapshot = Object.freeze(next); listeners.forEach(listener => listener()) }
  function cancel() {
    generation++
    const previous = active
    active = null
    previous?.abort.abort()
    if (expiryTimer !== undefined) clearTimer(expiryTimer)
    expiryTimer = undefined
  }
  function current(attempt: Attempt) { return !disposed && active === attempt && generation === attempt.generation && scope.key === attempt.scope.key && !attempt.abort.signal.aborted }
  function check(attempt: Attempt) { ensure(current(attempt), "AUTH_ATTEMPT_CANCELLED") }
  function fresh() {
    if (snapshot.session) {
      const time = now()
      if (!Number.isFinite(time) || time < snapshot.session.createdAt || time >= snapshot.session.expiresAt) {
        cancel()
        snapshot = Object.freeze({ status: "signed-out", session: null, error: "SESSION_EXPIRED" })
        const expired = snapshot
        // getSnapshot can run during React render. Notify after that stack, even
        // if this read found expiry before the (now cancelled) timer callback.
        queueMicrotask(() => { if (!disposed && snapshot === expired) listeners.forEach(fn => fn()) })
      }
    }
    return snapshot
  }
  async function bounded<T>(attempt: Attempt, work: () => Promise<T>, until: number, code: string): Promise<T> {
    check(attempt)
    const started = now()
    ensure(Number.isFinite(started) && started < until, code)
    let timer: unknown
    let onAbort = () => {}
    const stop = new Promise<never>((_, reject) => {
      onAbort = () => reject(new AuthError("AUTH_ATTEMPT_CANCELLED"))
      attempt.abort.signal.addEventListener("abort", onAbort, { once: true })
      timer = setTimer(() => { reject(new AuthError(code)); attempt.abort.abort() }, until - started)
    })
    try {
      const result = await Promise.race([Promise.resolve().then(() => { check(attempt); return work() }), stop])
      check(attempt)
      const time = now()
      ensure(Number.isFinite(time) && time >= started && time < until, code)
      return result
    } finally {
      if (timer !== undefined) clearTimer(timer)
      attempt.abort.signal.removeEventListener("abort", onAbort)
    }
  }
  function post(attempt: Attempt, path: string, body: unknown, deadline = now() + timeout) {
    return bounded(attempt, async () => {
      const response = await transport(`${attempt.scope.api}${path}`, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "omit", redirect: "error", cache: "no-store", signal: attempt.abort.signal, body: JSON.stringify(body),
      })
      ensure(response.ok, response.status === 401 || response.status === 403 ? "AUTH_REJECTED" : "AUTH_UNAVAILABLE")
      const text = await response.text()
      ensure(text.length <= 16_384, "INVALID_AUTH_RESPONSE")
      return object(JSON.parse(text))
    }, Math.min(deadline, now() + timeout), "AUTH_TIMEOUT")
  }
  async function run(attempt: Attempt): Promise<HostSession | null> {
    const own = attempt.scope
    try {
      check(attempt)
      ensure(own.wallet && own.chain === 91342, "GIWA_WALLET_REQUIRED")
      const nonce = await post(attempt, "/api/v1/auth/nonce", { walletAddress: own.wallet.toLowerCase(), domain: own.domain })
      ensure(typeof nonce.walletAddress === "string" && nonce.walletAddress.toLowerCase() === own.wallet.toLowerCase() && nonce.domain === own.domain, "INVALID_AUTH_RESPONSE")
      ensure(typeof nonce.nonce === "string" && /^[a-zA-Z0-9]{8,256}$/.test(nonce.nonce), "INVALID_AUTH_RESPONSE")
      ensure(typeof nonce.expiresAt === "string", "INVALID_AUTH_RESPONSE")
      const nonceExpiry = Date.parse(nonce.expiresAt)
      const issued = now()
      ensure(Number.isFinite(issued) && Number.isFinite(nonceExpiry) && nonceExpiry > issued, "NONCE_EXPIRED")
      const deadline = Math.min(nonceExpiry, issued + 900_000)
      const message = createSiweMessage({
        address: own.wallet, chainId: 91342, domain: own.domain, uri: own.origin,
        version: "1", nonce: nonce.nonce, issuedAt: new Date(issued), expirationTime: new Date(deadline),
        statement: "Sign in to ARCO GIWA Stocks. This does not authorize a transaction.",
      })
      const signature = await bounded(attempt, () => dependencies.signMessage({ account: own.wallet!, chainId: 91342, message }), deadline, "NONCE_EXPIRED")
      ensure(typeof signature === "string" && /^0x[0-9a-fA-F]{130}$/.test(signature), "INVALID_SIGNATURE")
      const verifiedAt = now()
      const response = await post(attempt, "/api/v1/auth/verify", { message, signature }, deadline)
      check(attempt)
      ensure(typeof response.walletAddress === "string" && response.walletAddress.toLowerCase() === own.wallet.toLowerCase() && response.chainId === 91342, "INVALID_AUTH_RESPONSE")
      ensure(typeof response.token === "string" && typeof response.expiresIn === "number" && Number.isInteger(response.expiresIn) && response.expiresIn > 0 && response.expiresIn <= 900, "INVALID_AUTH_RESPONSE")
      const claims = jwtClaims(response.token)
      const time = now()
      ensure(typeof claims.sub === "string" && isAddress(claims.sub) && claims.sub.toLowerCase() === own.wallet.toLowerCase() && claims.chainId === 91342 && claims.domain === own.domain, "INVALID_AUTH_RESPONSE")
      ensure(typeof claims.iat === "number" && Number.isInteger(claims.iat) && typeof claims.exp === "number" && Number.isInteger(claims.exp), "INVALID_AUTH_RESPONSE")
      ensure(claims.iat * 1000 <= time + 5000 && time - claims.iat * 1000 <= 900_000 && claims.exp > claims.iat && claims.exp - claims.iat <= 900, "INVALID_AUTH_RESPONSE")
      const expiresAt = Math.min(claims.exp * 1000, verifiedAt + response.expiresIn * 1000)
      ensure(Number.isFinite(time) && time >= verifiedAt && time < expiresAt, "SESSION_EXPIRED")
      const session: HostSession = Object.freeze({ id: `${instanceId}:${attempt.generation}`, walletAddress: own.wallet, chainId: 91342, accessToken: response.token, createdAt: time, expiresAt })
      expiryTimer = setTimer(() => { fresh() }, expiresAt - time)
      publish({ status: "authenticated", session, error: null })
      check(attempt)
      return session
    } catch (error) {
      // An abort from our deadline is still the current generation; a replaced/logout
      // attempt is not. Only the former may publish a failure to this session.
      if (!disposed && active === attempt && generation === attempt.generation) {
        attempt.abort.abort()
        publish({ status: "error", session: null, error: error instanceof AuthError ? error.message : "SIGN_IN_FAILED" })
      }
      return null
    } finally { if (active === attempt) active = null }
  }
  return {
    getSnapshot: () => fresh(),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    setContext(context: HostContext) {
      ensure(!disposed, "AUTH_DISPOSED")
      let next: Scope
      try { next = scopeOf(context) } catch { invalidContext = true; cancel(); publish({ status: "error", session: null, error: "INVALID_AUTH_CONTEXT" }); throw new AuthError("INVALID_AUTH_CONTEXT") }
      invalidContext = false
      if (scope.key !== next.key) { cancel(); scope = next; publish(OUT) }
    },
    signIn(): Promise<HostSession | null> {
      if (disposed || invalidContext) return Promise.resolve(null)
      if (active?.promise) return active.promise
      cancel()
      const attempt: Attempt = { generation, abort: new AbortController(), scope }
      active = attempt
      attempt.promise = Promise.resolve().then(() => run(attempt))
      publish({ status: "signing-in", session: null, error: null })
      return attempt.promise
    },
    logout() { cancel(); publish(OUT) },
    /** Pass the ID captured by the failed request, never a newly read session ID. */
    invalidate(sessionId: string) { if (fresh().session?.id === sessionId) { cancel(); publish({ status: "signed-out", session: null, error: "SESSION_REJECTED" }) } },
    refresh() { fresh() },
    dispose() { disposed = true; cancel(); publish(OUT); listeners.clear() },
  }
}
export type StocksHostController = ReturnType<typeof createStocksHostSession>

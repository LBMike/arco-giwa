// One bounded, read-only GET. The same limits as the reviewed submission client (stocks-wallet-submissions):
// explicit bearer token, no cookies, no cache, no redirects, a single deadline over fetch, streamed body,
// parsing and validation, a byte limit, and monotonic elapsed-time acceptance.

import { fail, StocksExecutionReadError, type ExecutionReadCode } from "./errors"
import type { ReadClock } from "./validate"

export const MAX_RESPONSE_BYTES = 32_768
export const DEFAULT_TIMEOUT_MS = 10_000
/** A lease lives at most 15 s; waiting longer than that for one is never useful. */
export const MAX_TIMEOUT_MS = 15_000

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export type TransportOptions = {
  apiBase: string
  fetch?: FetchLike
  now?: () => number
  monotonicNow?: () => number
  timeoutMs?: number
  onSessionRejected?: (capturedSessionId: string) => void
}

/** A request frozen when the call started. Nothing is read from the host after that. */
export type CapturedRead = Readonly<{
  /** null: public route, sent without Authorization. */
  token: string | null
  sessionId: string | null
  signal: AbortSignal
}>

export type AcceptedClock = ReadClock & Readonly<{ monotonic: number }>

export function normalizeApiBase(value: unknown): string | null {
  if (typeof value !== "string") return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) return null
  return url.href.replace(/\/+$/, "")
}

export function createReadTransport(options: TransportOptions) {
  const base = normalizeApiBase(options.apiBase)
  if (base === null) fail("INVALID_CONTEXT", "INVALID_REQUEST")
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) fail("INVALID_CONTEXT", "INVALID_REQUEST")
  const fetcher: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const now = options.now ?? Date.now
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const onSessionRejected = options.onSessionRejected

  /**
   * `denied(status)` names the failure for a non-2xx answer. 401 on an authenticated read first notifies
   * `onSessionRejected` with the session id captured for THIS request, then fails with status 401.
   */
  async function get<T>(captured: CapturedRead, path: string, denied: (status: number) => ExecutionReadCode, accept: (json: unknown, clock: AcceptedClock) => T): Promise<T> {
    const startedWall = now()
    const startedMono = monotonicNow()
    if (!Number.isFinite(startedWall) || !Number.isFinite(startedMono)) fail("READ_TIMEOUT", "CLOCK")
    const url = `${base}${path}`
    const internal = new AbortController()
    let rejectStop!: (error: StocksExecutionReadError) => void
    const stop = new Promise<never>((_, reject) => {
      rejectStop = reject
    })
    stop.catch(() => undefined)
    const onAbort = () => {
      internal.abort()
      rejectStop(new StocksExecutionReadError("CONTEXT_CHANGED", "ABORTED"))
    }
    const bound = <V>(promise: Promise<V>) => Promise.race([promise, stop])
    const clock = (): AcceptedClock => {
      const wall = now()
      const monotonic = monotonicNow()
      if (captured.signal.aborted) fail("CONTEXT_CHANGED", "ABORTED")
      if (!Number.isFinite(wall) || !Number.isFinite(monotonic) || wall < startedWall) fail("READ_TIMEOUT", "CLOCK")
      const elapsed = monotonic - startedMono
      if (!(elapsed >= 0) || elapsed >= timeoutMs || internal.signal.aborted) fail("READ_TIMEOUT", "TIMEOUT")
      return { wall, effective: Math.max(wall, startedWall + elapsed), monotonic }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let response: Response | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let completed = false
    try {
      if (captured.signal.aborted) fail("CONTEXT_CHANGED", "ABORTED")
      captured.signal.addEventListener("abort", onAbort, { once: true })
      timer = setTimeout(() => {
        internal.abort()
        rejectStop(new StocksExecutionReadError("READ_TIMEOUT", "TIMEOUT"))
      }, timeoutMs)
      const headers: Record<string, string> = { accept: "application/json" }
      if (captured.token !== null) headers.authorization = `Bearer ${captured.token}`
      try {
        response = await bound(fetcher(url, { method: "GET", headers, credentials: "omit", cache: "no-store", redirect: "error", signal: internal.signal }))
      } catch (error) {
        if (error instanceof StocksExecutionReadError) throw error
        // Includes a refused redirect: fetch rejects with redirect "error".
        fail(captured.signal.aborted ? "CONTEXT_CHANGED" : "REQUEST_FAILED", captured.signal.aborted ? "ABORTED" : "NETWORK")
      }
      clock()
      if (response.redirected || response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400) || (response.url !== "" && response.url !== url)) {
        fail("INVALID_RESPONSE", "REDIRECT", response.status)
      }
      if (response.status === 401 && captured.sessionId !== null) {
        try {
          onSessionRejected?.(captured.sessionId)
        } catch {
          /* A failing notification still fails closed. */
        }
        fail("SESSION_REJECTED", "UNAUTHENTICATED", 401)
      }
      if (response.status < 200 || response.status > 299) fail(denied(response.status), "HTTP_STATUS", response.status)
      if (response.status !== 200) fail("INVALID_RESPONSE", "HTTP_STATUS", response.status)
      const length = response.headers.get("content-length")
      if (length !== null && !(/^\d{1,10}$/.test(length) && BigInt(length) <= BigInt(MAX_RESPONSE_BYTES))) fail("INVALID_RESPONSE", "BODY_TOO_LARGE", 200)
      if (!response.body) fail("INVALID_RESPONSE", "BODY_UNREADABLE", 200)
      reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      for (;;) {
        let part: ReadableStreamReadResult<Uint8Array>
        try {
          part = await bound(reader.read())
        } catch (error) {
          if (error instanceof StocksExecutionReadError) throw error
          fail(captured.signal.aborted ? "CONTEXT_CHANGED" : "REQUEST_FAILED", captured.signal.aborted ? "ABORTED" : "BODY_UNREADABLE", 200)
        }
        clock()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > MAX_RESPONSE_BYTES) fail("INVALID_RESPONSE", "BODY_TOO_LARGE", 200)
        chunks.push(part.value)
      }
      const joined = new Uint8Array(bytes)
      let offset = 0
      for (const chunk of chunks) {
        joined.set(chunk, offset)
        offset += chunk.byteLength
      }
      let json: unknown
      try {
        json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined))
      } catch {
        fail("INVALID_RESPONSE", "NOT_JSON", 200)
      }
      const result = accept(json, clock())
      // Validation work counts against the same deadline.
      clock()
      completed = true
      return result
    } catch (error) {
      if (error instanceof StocksExecutionReadError) throw error
      throw new StocksExecutionReadError("INVALID_RESPONSE", "SHAPE")
    } finally {
      clearTimeout(timer)
      captured.signal.removeEventListener("abort", onAbort)
      if (!completed) {
        internal.abort()
        if (reader) void reader.cancel().catch(() => undefined)
        else if (response?.body && !response.bodyUsed && !response.body.locked) void response.body.cancel().catch(() => undefined)
      }
      reader?.releaseLock()
    }
  }

  return Object.freeze({ base, get })
}

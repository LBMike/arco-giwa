import { normalizeApiBase as normalizeCommonApiBase } from "../api-base"
import type { Catalog, Chart, Dividend, Envelope, MarketFetch, NvdaLiveSnapshot, Profile, Quote, Range } from "./contracts"
import { envelope, parseCatalog, parseChart, parseDividend, parseNvdaLiveSnapshot, parseProfile, parseQuotes, symbol } from "./validate"
export type MarketEventSource = { addEventListener: EventTarget["addEventListener"]; close(): void }
export type MarketEventSourceFactory = (url: string, init: { withCredentials: false }) => MarketEventSource
export type MarketClient = { baseUrl: string; catalog(signal: AbortSignal): Promise<Envelope<Catalog>>; quotes(symbols: readonly string[], signal: AbortSignal): Promise<Envelope<Quote[]>>; profile(name: string, signal: AbortSignal): Promise<Envelope<Profile>>; dividend(name: string, signal: AbortSignal): Promise<Envelope<Dividend>>; chart(name: string, range: Range, signal: AbortSignal): Promise<Envelope<Chart>>; liveNvda(signal: AbortSignal): Promise<NvdaLiveSnapshot>; subscribeNvda(onSnapshot: (snapshot: NvdaLiveSnapshot) => void, onError: () => void): (() => void) | null }
export function normalizeApiBase(value: string): string {
  const base = normalizeCommonApiBase(value)
  if (base === null) throw new Error("INVALID_API_BASE")
  return base
}
export function createMarketClient(base: string, fetcher: MarketFetch = (url, init) => globalThis.fetch(url, init), timeoutMs = 10_000, eventSourceFactory?: MarketEventSourceFactory): MarketClient {
  const baseUrl = normalizeApiBase(base)
  async function read<T>(path: string, signal: AbortSignal, parse: (value: unknown) => T, maxBytes = 2_000_000): Promise<T> {
    const startedAt = performance.now()
    const elapsed = () => performance.now() - startedAt >= timeoutMs
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined
    let rejectAbort!: (reason: Error) => void
    const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject })
    const cancel = () => { abort.abort(); rejectAbort(new Error("MARKET_REQUEST_CANCELLED")) }
    signal.addEventListener("abort", cancel, { once: true })
    if (signal.aborted) cancel()
    timer = setTimeout(cancel, timeoutMs)
    try {
      const work = async () => {
        if (abort.signal.aborted) throw new Error("MARKET_REQUEST_CANCELLED")
        const response = await fetcher(`${baseUrl}/api/v1/stocks/market/${path}`, { method: "GET", signal: abort.signal, credentials: "omit", redirect: "error", cache: "no-store", headers: { accept: "application/json" } })
        if (!response.ok) throw new Error("MARKET_HTTP_UNAVAILABLE")
        const reader = response.body?.getReader(); if (!reader) throw new Error("MARKET_RESPONSE_INVALID")
        const chunks: Uint8Array[] = []; let bytes = 0
        try { for (;;) { const part = await Promise.race([reader.read(), cancelled]); if (part.done) break; bytes += part.value.length; if (bytes > maxBytes || abort.signal.aborted) throw new Error("MARKET_RESPONSE_INVALID"); chunks.push(part.value) } }
        finally { if (abort.signal.aborted || bytes > maxBytes) void reader.cancel().catch(() => {}); reader.releaseLock() }
        const joined = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length }
        if (abort.signal.aborted || elapsed()) throw new Error("MARKET_REQUEST_CANCELLED")
        const result = parse(JSON.parse(new TextDecoder().decode(joined)))
        if (abort.signal.aborted || elapsed()) throw new Error("MARKET_REQUEST_CANCELLED")
        return result
      }
      return await Promise.race([work(), cancelled])
    } finally { if (timer) clearTimeout(timer); signal.removeEventListener("abort", cancel) }
  }
  const get = <T,>(path: string, signal: AbortSignal, parse: (value: unknown) => T) => read(path, signal, value => envelope(value, parse))
  const subscribeNvda: MarketClient["subscribeNvda"] = (onSnapshot, onError) => {
    const factory = eventSourceFactory ?? (typeof globalThis.EventSource === "function" ? (url: string, init: { withCredentials: false }) => new globalThis.EventSource(url, init) : null)
    if (!factory) return null
    let source: MarketEventSource
    try { source = factory(`${baseUrl}/api/v1/stocks/market/NVDA/live/stream`, { withCredentials: false }) }
    catch { onError(); return null }
    let closed = false
    const close = () => { if (!closed) { closed = true; source.close() } }
    try {
      source.addEventListener("snapshot", event => {
        if (closed) return
        let snapshot: NvdaLiveSnapshot
        try {
          const data = (event as MessageEvent<unknown>).data
          if (typeof data !== "string" || data.length > 65_536 || new TextEncoder().encode(data).byteLength > 65_536) throw new Error("MARKET_RESPONSE_INVALID")
          snapshot = parseNvdaLiveSnapshot(JSON.parse(data))
        } catch { close(); onError(); return }
        onSnapshot(snapshot)
      })
      source.addEventListener("error", () => { if (!closed) onError() })
    } catch { close(); onError(); return null }
    return close
  }
  return { baseUrl, catalog: signal => get("catalog", signal, parseCatalog), quotes: (symbols, signal) => get("quotes", signal, value => parseQuotes(value, symbols)), profile: (name, signal) => get(`${symbol(name)}/profile`, signal, value => parseProfile(value, name, baseUrl)), dividend: (name, signal) => get(`${symbol(name)}/dividend`, signal, value => parseDividend(value, name)), chart: (name, range, signal) => get(`${symbol(name)}/chart?range=${range}`, signal, value => parseChart(value, name, range)), liveNvda: signal => read("NVDA/live", signal, parseNvdaLiveSnapshot, 65_536), subscribeNvda }
}

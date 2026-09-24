import { normalizeApiBase as normalizeCommonApiBase } from "../api-base"
import type { Catalog, Chart, Envelope, MarketFetch, Profile, Quote, Range } from "./contracts"
import { envelope, parseCatalog, parseChart, parseProfile, parseQuotes, symbol } from "./validate"
export type MarketClient = { baseUrl: string; catalog(signal: AbortSignal): Promise<Envelope<Catalog>>; quotes(symbols: readonly string[], signal: AbortSignal): Promise<Envelope<Quote[]>>; profile(name: string, signal: AbortSignal): Promise<Envelope<Profile>>; chart(name: string, range: Range, signal: AbortSignal): Promise<Envelope<Chart>> }
export function normalizeApiBase(value: string): string {
  const base = normalizeCommonApiBase(value)
  if (base === null) throw new Error("INVALID_API_BASE")
  return base
}
export function createMarketClient(base: string, fetcher: MarketFetch = (url, init) => globalThis.fetch(url, init), timeoutMs = 10_000): MarketClient {
  const baseUrl = normalizeApiBase(base)
  async function get<T>(path: string, signal: AbortSignal, parse: (value: unknown) => T): Promise<Envelope<T>> {
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
        try { for (;;) { const part = await Promise.race([reader.read(), cancelled]); if (part.done) break; bytes += part.value.length; if (bytes > 2_000_000 || abort.signal.aborted) throw new Error("MARKET_RESPONSE_INVALID"); chunks.push(part.value) } }
        finally { if (abort.signal.aborted || bytes > 2_000_000) void reader.cancel().catch(() => {}); reader.releaseLock() }
        const joined = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length }
        if (abort.signal.aborted || elapsed()) throw new Error("MARKET_REQUEST_CANCELLED")
        const result = envelope(JSON.parse(new TextDecoder().decode(joined)), parse)
        if (abort.signal.aborted || elapsed()) throw new Error("MARKET_REQUEST_CANCELLED")
        return result
      }
      return await Promise.race([work(), cancelled])
    } finally { if (timer) clearTimeout(timer); signal.removeEventListener("abort", cancel) }
  }
  return { baseUrl, catalog: signal => get("catalog", signal, parseCatalog), quotes: (symbols, signal) => get("quotes", signal, value => parseQuotes(value, symbols)), profile: (name, signal) => get(`${symbol(name)}/profile`, signal, value => parseProfile(value, name, baseUrl)), chart: (name, range, signal) => get(`${symbol(name)}/chart?range=${range}`, signal, value => parseChart(value, name, range)) }
}

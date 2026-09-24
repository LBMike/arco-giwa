import { useEffect, useMemo, useState } from "react"
import type { MarketClient } from "./client"
import type { Envelope, NvdaLiveSnapshot, Quote } from "./contracts"
import { startVisiblePolling } from "./polling"
import type { ReadState } from "./useOwnedRead"

export type MarketLiveConnection = "off" | "connecting" | "streaming" | "reconnecting" | "unavailable" | "paused"
type Connection = MarketLiveConnection
type Owned = {
  client: MarketClient
  key: string
  quotes: ReadState<Envelope<Quote[]>>
  live: NvdaLiveSnapshot | null
  connection: Connection
}
export type MarketQuoteView = {
  quotes: ReadState<Envelope<Quote[]>>
  live: NvdaLiveSnapshot | null
  connection: Connection
}
const LOADING: ReadState<Envelope<Quote[]>> = { phase: "loading" }

/** The stream owns NVDA's latest row; the batch read supplies the other listed symbols. */
export function withNvdaSnapshot(quotes: ReadState<Envelope<Quote[]>>, live: NvdaLiveSnapshot | null, connection: Connection): ReadState<Envelope<Quote[]>> {
  if (!live || connection !== "streaming") return quotes
  const underlying = live.underlying
  const nvda: Quote = {
    symbol: "NVDA", currency: "USD", price: underlying.price,
    change: underlying.change, changePercent: underlying.changePercent,
    sessionVolume: underlying.sessionVolume, previousClose: underlying.previousClose,
    sourceTimestamp: underlying.sourceTimestamp, observationAgeMs: underlying.observationAgeMs,
    priceSource: underlying.priceSource, status: underlying.status, reason: underlying.reason,
  }
  const batch = quotes.phase === "ready" ? quotes.value : null
  const rows = batch?.data ? [...batch.data] : []
  const index = rows.findIndex(row => row.symbol === "NVDA")
  const priorTime = index < 0 ? null : rows[index].sourceTimestamp
  // CLOSED snapshots can be cached longer than a separate quote batch. Keep the
  // newer observation rather than moving the visible price/time backwards.
  if (priorTime && (!underlying.sourceTimestamp || Date.parse(priorTime) > Date.parse(underlying.sourceTimestamp))) return quotes
  if (index < 0) rows.push(nvda)
  else rows[index] = nvda
  // The batch envelope describes its old rows. Recalculate it after replacing
  // NVDA so an unavailable batch cannot mask a usable live quote (or vice versa).
  const stale = rows.find(row => row.status === "STALE")
  const unavailable = rows.find(row => row.status === "UNAVAILABLE")
  const unconfigured = rows.find(row => row.status === "UNCONFIGURED")
  const status = stale ? "STALE" : rows.some(row => row.status === "AVAILABLE") ? "AVAILABLE" : unavailable ? "UNAVAILABLE" : "UNCONFIGURED"
  const reason = status === "STALE" ? stale!.reason : status === "UNAVAILABLE" ? unavailable!.reason : status === "UNCONFIGURED" ? unconfigured?.reason ?? null : null
  const provider = underlying.price !== null ? underlying.provider ?? batch?.provider : batch?.provider
  const marketFeed = provider === "ALPACA" ? (underlying.provider === "ALPACA" ? underlying.marketFeed ?? undefined : batch?.marketFeed) : undefined
  return { phase: "ready", value: {
    status, reason, data: rows,
    provider, marketFeed,
    feedDelay: underlying.price !== null ? underlying.feedDelay : batch?.feedDelay ?? underlying.feedDelay,
    fetchedAt: batch?.fetchedAt ?? live.observedAt,
    cacheAgeMs: batch?.cacheAgeMs ?? 0,
  } }
}

/** One batch read on entry; SSE ticks reuse the server's shared quote cache. Polling is the disconnect fallback. */
export function useMarketQuotes(client: MarketClient, symbols: readonly string[], enableStream: boolean): MarketQuoteView {
  const key = JSON.stringify(symbols)
  const names = useMemo(() => JSON.parse(key) as string[], [key])
  const streamEnabled = enableStream && names.includes("NVDA")
  const [owned, setOwned] = useState<Owned | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    let connection: Connection = streamEnabled ? "connecting" : "off"
    let stopStream: (() => void) | null = null
    let lastAttempt = -Infinity
    let lastBatchAt = 0
    let lastSession: NvdaLiveSnapshot["marketSession"] | null = null
    let pending: Promise<void> | null = null
    const update = (change: (current: Owned) => Owned) => setOwned(current =>
      active && current?.client === client && current.key === key ? change(current) : current)
    setOwned({ client, key, quotes: LOADING, live: null, connection })

    const refresh = (): Promise<void> => {
      if (pending) return pending
      const work = client.quotes(names, controller.signal).then(value => {
        if (!controller.signal.aborted) {
          lastBatchAt = Date.now()
          update(current => ({ ...current, quotes: { phase: "ready", value } }))
        }
      }, () => {
        if (!controller.signal.aborted) update(current => ({ ...current, quotes: { phase: "error" } }))
      }).finally(() => { if (pending === work) pending = null })
      pending = work
      return work
    }
    const closedWithRecentBatch = () => lastSession?.state === "CLOSED" &&
      Date.now() < Date.parse(lastSession.nextOpen ?? "") &&
      lastBatchAt > 0 && Date.now() - lastBatchAt < 15 * 60_000

    const attach = () => {
      if (!streamEnabled || !client.subscribeNvda || stopStream || document.hidden || !active) return
      lastAttempt = Date.now()
      connection = "connecting"
      update(current => ({ ...current, connection }))
      let closedDuringSubscribe = false
      const onError = () => {
        if (!active) return
        connection = "reconnecting"
        update(current => ({ ...current, connection }))
        if (stopStream) { stopStream(); stopStream = null }
        else closedDuringSubscribe = true
      }
      const subscription = client.subscribeNvda(snapshot => {
        if (!active || document.hidden) return
        const transitioned = lastSession !== null && lastSession.state !== snapshot.marketSession.state
        lastSession = snapshot.marketSession
        connection = "streaming"
        update(current => ({ ...current, live: snapshot, connection }))
        // The server has just read the shared quote cache. Closed-market ticks
        // keep the last provider observation without causing an extra read.
        if (transitioned || !closedWithRecentBatch()) void refresh()
      }, onError)
      stopStream = subscription
      if (closedDuringSubscribe && stopStream) { stopStream(); stopStream = null }
      if (!subscription) {
        connection = "unavailable"
        update(current => ({ ...current, connection }))
      }
    }

    // A healthy stream replaces independent 30-second reads. When it fails, the
    // existing cadence remains available and stream reconnection is bounded.
    const stopPolling = startVisiblePolling(async () => {
      if (connection !== "streaming" && !closedWithRecentBatch()) await refresh()
      if (streamEnabled && !stopStream && Date.now() - lastAttempt >= 60_000) attach()
    }, 30_000)
    const visibility = () => {
      if (document.hidden) {
        stopStream?.(); stopStream = null
        connection = "paused"
        update(current => ({ ...current, connection }))
      } else {
        lastAttempt = -Infinity
        if (!closedWithRecentBatch()) void refresh()
        attach()
      }
    }
    document.addEventListener("visibilitychange", visibility)
    if (streamEnabled) attach()
    return () => {
      active = false
      stopPolling()
      document.removeEventListener("visibilitychange", visibility)
      stopStream?.()
      controller.abort()
    }
  }, [client, key, names, streamEnabled])
  const state = owned?.client === client && owned.key === key ? owned : null
  const connection = state?.connection ?? (streamEnabled ? "connecting" : "off")
  const live = state?.live ?? null
  const sourceQuotes = state?.quotes ?? LOADING
  const quotes = useMemo(() => withNvdaSnapshot(sourceQuotes, live, connection), [sourceQuotes, live, connection])
  return { quotes, live, connection }
}

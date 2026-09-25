import { useEffect, useMemo, useState, type RefObject } from "react"
import { startVisiblePolling } from "./polling"
import type { MarketClient } from "./client"
import type { Chart, Profile } from "./contracts"

export type MarketRows = { series: Readonly<Record<string, Chart>>; profiles: Readonly<Record<string, Profile>> }
type Kind = "chart" | "profile"
type Publish = (symbol: string, kind: Kind, data: Chart | Profile | null, preserveExisting?: boolean) => void
/** Read actual rendered rows; filtering/sorting and scrolling can change priority mid-queue. */
function visibleRowSymbols(container: HTMLElement | null): string[] {
  if (!container || typeof window === "undefined") return []
  const bottom = window.innerHeight || document.documentElement.clientHeight
  return [...container.querySelectorAll<HTMLElement>('[data-row-primary][data-symbol]')]
    .filter(element => { const box = element.getBoundingClientRect(); return box.bottom > 0 && box.top < bottom })
    .map(element => element.dataset.symbol).filter((symbol): symbol is string => Boolean(symbol))
}
/** Bounded reads; wait for the provider budget to recover instead of flooding it with every row. */
export async function loadMarketRows(client: MarketClient, symbols: readonly string[], signal: AbortSignal, charts: boolean, publish: Publish, prioritySymbols: () => readonly string[] = () => []) {
  const pause = () => new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve() }
    const timer = setTimeout(finish, 60_000)
    signal.addEventListener("abort", finish, { once: true })
    if (signal.aborted) finish()
  })
  async function load(tasks: { symbol: string; kind: Kind }[], concurrency: number) {
    const pending = new Map(tasks.map(task => [task.symbol, task]))
    const throttled = new Map<string, { symbol: string; kind: Kind }>()
    let retryWait: Promise<void> | null = null
    const next = () => {
      const preferred = prioritySymbols()
      const symbol = preferred.find(symbol => pending.has(symbol)) ?? pending.keys().next().value as string | undefined
      if (!symbol) return null
      const task = pending.get(symbol)!
      pending.delete(symbol)
      return task
    }
    async function worker() {
      while (!signal.aborted) {
        const task = next()
        if (!task) {
          if (!throttled.size && !retryWait) return
          // A provider-limited row must not hold up later rows already in the server cache.
          // Workers share one cooldown, then retry only the deferred rows.
          retryWait ??= pause().then(() => {
            for (const [symbol, deferred] of throttled) pending.set(symbol, deferred)
            throttled.clear()
            retryWait = null
          })
          await retryWait
          continue
        }
        try {
          const response = task.kind === "chart" ? await client.chart(task.symbol, "1D", signal) : await client.profile(task.symbol, signal)
          if (signal.aborted) return
          if (["REQUEST_BUDGET_EXHAUSTED", "PROVIDER_RATE_LIMITED"].includes(response.reason ?? "")) {
            // A throttled refresh must not replace an earlier complete valuation with null/partial facts.
            if (response.data) publish(task.symbol, task.kind, response.data, true)
            throttled.set(task.symbol, task)
            continue
          }
          publish(task.symbol, task.kind, response.data && (response.status === "AVAILABLE" || response.status === "STALE") ? response.data : null)
        } catch { if (!signal.aborted) publish(task.symbol, task.kind, null) }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker))
  }
  // Separate providers have separate free-plan budgets. A throttled profile read must not hold
  // the workers that fill the list's price charts (or vice versa).
  await Promise.all([
    charts ? load(symbols.map(symbol => ({ symbol, kind: "chart" })), 2) : Promise.resolve(),
    load(symbols.map(symbol => ({ symbol, kind: "profile" })), 1),
  ])
}
const EMPTY: MarketRows = { series: {}, profiles: {} }
/** A budget-limited partial response can fill a blank row, but cannot erase an existing valuation. */
export function applyMarketRow(previous: MarketRows, symbol: string, kind: Kind, data: Chart | Profile | null, preserveExisting = false): MarketRows {
  if (preserveExisting && (kind === "chart" ? previous.series[symbol] : previous.profiles[symbol])) return previous
  if (!data) {
    if (kind === "chart") { const series = { ...previous.series }; delete series[symbol]; return { ...previous, series } }
    const profiles = { ...previous.profiles }; delete profiles[symbol]; return { ...previous, profiles }
  }
  return kind === "chart" ? { ...previous, series: { ...previous.series, [symbol]: data as Chart } } : { ...previous, profiles: { ...previous.profiles, [symbol]: data as Profile } }
}
/** The owner remains mounted across list/detail navigation; changing clients fences old results. */
export function useMarketRows(client: MarketClient, symbols: readonly string[], charts: boolean, onChart?: (symbol: string, chart: Chart | null) => void, container?: RefObject<HTMLElement>, enabled = true): MarketRows {
  const key = JSON.stringify(symbols)
  const names = useMemo(() => JSON.parse(key) as string[], [key])
  const [state, setState] = useState<{ client: MarketClient; key: string; data: MarketRows } | null>(null)
  useEffect(() => {
    // The detail view has its own selected-symbol reads. Do not spend the shared free-plan
    // request budget on a hidden 40-row list; keep its last values for the return trip.
    if (!enabled) return
    const controller = new AbortController()
    setState(previous => previous?.client === client && previous.key === key ? previous : { client, key, data: EMPTY })
    const stop = startVisiblePolling(() => loadMarketRows(client, names, controller.signal, charts, (symbol, kind, data, preserveExisting) => {
      if (controller.signal.aborted) return
      if (kind === "chart" && !preserveExisting) onChart?.(symbol, data as Chart | null)
      setState(previous => {
        if (!previous || previous.client !== client || previous.key !== key) return previous
        const dataAfter = applyMarketRow(previous.data, symbol, kind, data, preserveExisting)
        return dataAfter === previous.data ? previous : { ...previous, data: dataAfter }
      })
    }, () => visibleRowSymbols(container?.current ?? null)), charts ? 300_000 : 0)
    return () => { stop(); controller.abort() }
  }, [client, key, names, charts, onChart, container, enabled])
  return state?.client === client && state.key === key ? state.data : EMPTY
}

import { useEffect, useMemo, useState } from "react"
import { startVisiblePolling } from "./polling"
import type { MarketClient } from "./client"
import type { Chart, Profile } from "./contracts"

export type MarketRows = { series: Readonly<Record<string, Chart>>; profiles: Readonly<Record<string, Profile>> }
/** Bounded reads; wait for the provider budget to recover instead of flooding it with every row. */
export async function loadMarketRows(client: MarketClient, symbols: readonly string[], signal: AbortSignal, charts: boolean, publish: (symbol: string, kind: "chart" | "profile", data: Chart | Profile | null) => void) {
  const pause = () => new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve() }
    const timer = setTimeout(finish, 60_000)
    signal.addEventListener("abort", finish, { once: true })
    if (signal.aborted) finish()
  })
  async function load(tasks: { symbol: string; kind: "chart" | "profile" }[], concurrency: number) {
    let index = 0
    async function worker() {
      while (!signal.aborted) {
        const task = tasks[index++]
        if (!task) return
        for (;;) {
          if (signal.aborted) return
          try {
            const response = task.kind === "chart" ? await client.chart(task.symbol, "1D", signal) : await client.profile(task.symbol, signal)
            if (signal.aborted) return
            if (["REQUEST_BUDGET_EXHAUSTED", "PROVIDER_RATE_LIMITED"].includes(response.reason ?? "")) {
              if (response.status === "AVAILABLE" && response.data) publish(task.symbol, task.kind, response.data)
              await pause(); continue
            }
            publish(task.symbol, task.kind, response.status === "AVAILABLE" ? response.data : null)
          } catch { if (!signal.aborted) publish(task.symbol, task.kind, null) }
          break
        }
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
/** The owner remains mounted across list/detail navigation; changing clients fences old results. */
export function useMarketRows(client: MarketClient, symbols: readonly string[], charts: boolean, onChart?: (symbol: string, chart: Chart | null) => void): MarketRows {
  const key = JSON.stringify(symbols)
  const names = useMemo(() => JSON.parse(key) as string[], [key])
  const [state, setState] = useState<{ client: MarketClient; key: string; data: MarketRows } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setState({ client, key, data: EMPTY })
    const stop = startVisiblePolling(() => loadMarketRows(client, names, controller.signal, charts, (symbol, kind, data) => {
      if (controller.signal.aborted) return
      if (kind === "chart") onChart?.(symbol, data as Chart | null)
      setState(previous => {
        if (!previous || previous.client !== client || previous.key !== key) return previous
        if (!data) {
          const next = { ...(kind === "chart" ? previous.data.series : previous.data.profiles) }; delete next[symbol]
          return { ...previous, data: { ...previous.data, [kind === "chart" ? "series" : "profiles"]: next } }
        }
        return { ...previous, data: kind === "chart" ? { ...previous.data, series: { ...previous.data.series, [symbol]: data as Chart } } : { ...previous.data, profiles: { ...previous.data.profiles, [symbol]: data as Profile } } }
      })
    }), charts ? 300_000 : 0)
    return () => { stop(); controller.abort() }
  }, [client, key, names, charts, onChart])
  return state?.client === client && state.key === key ? state.data : EMPTY
}

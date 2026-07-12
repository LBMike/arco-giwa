// Pure, unit-testable portfolio-level series builders for the personal-wallet Net Worth /
// Net Rate chart. Uses the "current balance × price-history" method: today's on-chain shares
// valued at each vault's historical navUsd, merged across held vaults on a common time axis
// with per-vault forward-fill. No React/I/O so it runs under `npm run test:frontend`.
import type { GiwaPriceHistory } from "./api"
import { buildApySeries, round4, type RawPoint } from "./detail-charts"

export type PortfolioPosition = {
  shares: number
  history: GiwaPriceHistory | undefined
}

type FillPoint = { t: number; value: number }

// Last value at or before `t` (forward-fill on ascending points), or null if none yet.
function fillAt(points: FillPoint[], t: number): number | null {
  let value: number | null = null
  for (const point of points) {
    if (point.t <= t) value = point.value
    else break
  }
  return value
}

function navPoints(history: GiwaPriceHistory | undefined): FillPoint[] {
  return (history?.points ?? [])
    .filter((point) => point.navUsd != null)
    .map((point) => ({ t: point.t, value: point.navUsd as number }))
    .sort((a, b) => a.t - b.t)
}

function mergedAxis(perVault: Array<{ times: number[] }>): number[] {
  return Array.from(new Set(perVault.flatMap((v) => v.times))).sort((a, b) => a - b)
}

// NET WORTH = Σ_v (current shares_v × navUsd_v(t)), forward-filled per vault. A point is
// emitted only where at least one held vault has a known price ≤ t. <2 points → empty.
export function buildNetWorthSeries(positions: PortfolioPosition[]): RawPoint[] {
  const perVault = positions.map((position) => ({ shares: position.shares, nav: navPoints(position.history) }))
  const axis = mergedAxis(perVault.map((v) => ({ times: v.nav.map((p) => p.t) })))
  const series: RawPoint[] = []
  for (const t of axis) {
    let sum = 0
    let priced = false
    for (const vault of perVault) {
      const nav = fillAt(vault.nav, t)
      if (nav != null) {
        sum += vault.shares * nav
        priced = true
      }
    }
    if (priced) series.push({ ts: t, value: round4(sum) })
  }
  return series.length >= 2 ? series : []
}

// NET RATE = value-weighted APY over time = Σ_v value_v(t)·apy_v(t) / Σ_v value_v(t), where
// value_v(t) = shares_v × navUsd_v(t) and apy_v(t) = the vault's implied APY at t (buildApySeries,
// forward-filled). Only apy-bearing vaults contribute to BOTH sums — nulls are excluded, never
// treated as 0%. <2 points → empty.
export function buildNetRateSeries(positions: PortfolioPosition[]): RawPoint[] {
  const perVault = positions.map((position) => ({
    shares: position.shares,
    nav: navPoints(position.history),
    apy: buildApySeries(position.history).map((point) => ({ t: point.ts, value: point.value })),
  }))
  const axis = mergedAxis(perVault.map((v) => ({ times: [...v.nav.map((p) => p.t), ...v.apy.map((p) => p.t)] })))
  const series: RawPoint[] = []
  for (const t of axis) {
    let weighted = 0
    let weight = 0
    for (const vault of perVault) {
      const apy = fillAt(vault.apy, t)
      if (apy == null) continue // no implied APY for this vault yet → exclude (don't dilute)
      const nav = fillAt(vault.nav, t)
      if (nav == null) continue
      const value = vault.shares * nav
      if (!(value > 0)) continue
      weighted += value * apy
      weight += value
    }
    if (weight > 0) series.push({ ts: t, value: round4(weighted / weight) })
  }
  return series.length >= 2 ? series : []
}

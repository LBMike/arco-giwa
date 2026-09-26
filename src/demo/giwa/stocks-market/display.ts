import type { Chart, Envelope, FeedDelay, Profile, Quote, Range } from "./contracts"
import { scaled } from "./validate"
export function exact(value: string | null): string { if (value === null) return "—"; const [whole, fraction = ""] = value.split("."); const trimmed = fraction.replace(/0+$/, ""); return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (trimmed ? `.${trimmed}` : "") }
export function dollars(value: string | null): string { return value === null ? "—" : `$${exact(value)}` }
/** Non-negative 1e18-scaled units → at most two decimals, half-up, no forced trailing zeros. */
function hundredths(units: bigint): { rounded: bigint; label: string } {
  const cent = 10n ** 16n
  const rounded = (units + cent / 2n) / cent
  const fraction = String(rounded % 100n).padStart(2, "0").replace(/0+$/, "")
  return { rounded, label: `${exact(String(rounded / 100n))}${fraction ? `.${fraction}` : ""}` }
}
/** Compact two-decimal UI label, rounded with integers; exact source remains in tooltip/table. */
export function priceLabel(value: string | null): string {
  if (value === null) return "—"
  return `$${hundredths(scaled(value)).label}`
}
/** Unsigned magnitude plus direction for change columns; a value that rounds to zero is flat. */
export function changeParts(value: string | null): { direction: "up" | "down" | "flat"; magnitude: string } | null {
  if (value === null) return null
  const units = scaled(value)
  const { rounded, label } = hundredths(units < 0n ? -units : units)
  return { direction: rounded === 0n ? "flat" : units < 0n ? "down" : "up", magnitude: label }
}
export const FEED_LABELS: Record<FeedDelay, string> = { UNKNOWN: "Feed delay unknown", DELAYED_15_MIN: "15-minute delay", END_OF_DAY: "End-of-day prices", REALTIME: "Real-time feed configured · Check observation time" }
export function time(value: string | null): string { return value === null ? "—" : `${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(new Date(value))}` }
function changeLabel(firstPrice: string, lastPrice: string): string {
  const first = scaled(firstPrice), last = scaled(lastPrice)
  // Exact integer arithmetic; round to two percentage decimals only for display.
  const numerator = (last - first) * 10_000n
  const magnitude = numerator < 0n ? -numerator : numerator
  const rounded = (magnitude + first / 2n) / first
  return `${numerator < 0n ? "−" : "+"}${rounded / 100n}.${String(rounded % 100n).padStart(2, "0")}%`
}
export type ChartPoint = { timestamp: number; coordinate: number; price: string; sourceTimestamp: string; bar: Chart["bars"][number]; segment: number; index: number; carried: boolean; muted: boolean; closed: boolean; liveQuote: boolean }
/** A split-adjusted quote may replace only the final display point of its own 1D window. */
function latestDisplayQuote(chart: Chart, quote: Quote | null | undefined): Quote | null {
  if (chart.range !== "1D" || chart.fallback !== null || !quote || quote.symbol !== chart.symbol || quote.price === null || quote.sourceTimestamp === null || (quote.status !== "AVAILABLE" && quote.status !== "STALE")) return null
  const observed = Date.parse(quote.sourceTimestamp)
  const lastBar = chart.bars[chart.bars.length - 1]
  return Number.isFinite(observed) && observed >= Date.parse(chart.from) && observed <= Date.parse(chart.to) + 6 * 60_000 && lastBar !== undefined && observed >= Date.parse(lastBar.timestamp) && scaled(quote.price) > 0n ? quote : null
}
const FIVE_MINUTES = 300_000
const DAY_MS = 86_400_000
const newYorkClock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
/** Regular US equity session only; carry-forward outside it is visually muted, not deleted. */
function regularSession(ms: number): boolean {
  const parts = newYorkClock.formatToParts(new Date(ms))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? ""
  if (part("weekday") === "Sat" || part("weekday") === "Sun") return false
  const minute = Number(part("hour")) * 60 + Number(part("minute"))
  return minute >= 9 * 60 + 30 && minute < 16 * 60
}
/** A display grid only: source OHLCV bars and their timestamps remain untouched. */
export function chartPoints(chart: Chart, latestQuote?: Quote | null): ChartPoint[] {
  if (chart.range === "1D") {
    const fallback = chart.fallback === "PREVIOUS_SESSION" && chart.fallbackBars.length >= 2
    const bars = fallback ? chart.fallbackBars : chart.bars
    if (!bars.length) return []
    const seed = fallback ? null : chart.seed
    if (!seed && bars.length === 1) {
      const bar = bars[0], timestamp = Date.parse(bar.timestamp)
      return [{ timestamp, coordinate: Number(bar.close), price: bar.close, sourceTimestamp: bar.timestamp, bar, segment: 0, index: 0, carried: false, muted: false, closed: false, liveQuote: false }]
    }
    const quote = fallback ? null : latestDisplayQuote(chart, latestQuote)
    const end = fallback ? Date.parse(bars[bars.length - 1].timestamp) : Math.max(Date.parse(chart.to), quote ? Date.parse(quote.sourceTimestamp!) : 0)
    const windowStart = end - DAY_MS
    const start = fallback ? Date.parse(bars[0].timestamp) : seed ? windowStart : Math.max(windowStart, Date.parse(bars[0].timestamp))
    if (end < start) return []
    const ticks = [start]
    for (let tick = Math.ceil((start + 1) / FIVE_MINUTES) * FIVE_MINUTES; tick < end; tick += FIVE_MINUTES) ticks.push(tick)
    if (end > start) ticks.push(end)
    let current = seed ?? bars[0], source = current.timestamp, cursor = 0
    return ticks.map((timestamp, index) => {
      while (cursor < bars.length && Date.parse(bars[cursor].timestamp) <= timestamp) { current = bars[cursor++]; source = current.timestamp }
      const isQuote = quote !== null && Date.parse(quote.sourceTimestamp!) <= timestamp
      const price = isQuote ? quote.price! : current.close
      const sourceTimestamp = isQuote ? quote.sourceTimestamp! : source
      const observed = sourceTimestamp === new Date(timestamp).toISOString()
      const closed = !regularSession(timestamp)
      return { timestamp, coordinate: Number(price), price, sourceTimestamp, bar: current, segment: 0, index, carried: !observed, muted: !observed && (closed || timestamp - Date.parse(sourceTimestamp) > 15 * 60_000), closed, liveQuote: isQuote }
    })
  }
  const width = chart.interval === "5m" ? 300000 : chart.interval === "1h" ? 3600000 : 86400000
  // Keep intraday gaps visible. Historical series should connect actual closes across
  // overnight, weekends and market holidays without synthesizing prices for closed sessions.
  // A gap longer than a normal long weekend remains disconnected.
  const gap = chart.interval === "5m" ? width * 3 : chart.interval === "1h" ? 4 * 86400000 : 5 * 86400000
  // Number conversion happens only here at the plotting boundary; labels retain original bars.
  let segment = 0
  return chart.bars.map((bar, index) => { const timestamp = Date.parse(bar.timestamp); if (index && timestamp - Date.parse(chart.bars[index - 1].timestamp) > gap) segment++; return { timestamp, coordinate: Number(bar.close), price: bar.close, sourceTimestamp: bar.timestamp, bar, segment, index, carried: false, muted: false, closed: false, liveQuote: false } })
}
export function chartTooltip(point: ChartPoint): string {
  const status = point.muted ? point.closed ? "Market closed · last trade" : "No trades · last trade" : point.liveQuote ? "Last trade" : null
  return [dollars(point.price), time(point.sourceTimestamp), status].filter(Boolean).join(" · ")
}
/** Keep both endpoints and regular quarter-hour points for a compact 1D table sparkline. */
export function sparklinePoints(chart: Chart, latestQuote?: Quote | null): ChartPoint[] {
  const points = chartPoints(chart, latestQuote)
  if (chart.range !== "1D" || points.length < 3) return points
  return points.filter((point, index) => index === 0 || index === points.length - 1 || point.timestamp % (15 * 60_000) === 0)
}
/** Adjacent runs share a boundary point, so tone changes never create a visual gap. */
export function chartLineRuns(points: readonly ChartPoint[], rolling: boolean): { points: ChartPoint[]; muted: boolean }[] {
  if (!points.length) return []
  if (!rolling) return [...new Set(points.map(point => point.segment))].map(segment => ({ points: points.filter(point => point.segment === segment), muted: false }))
  if (points.length === 1) return [{ points: [points[0]], muted: false }]
  const runs: { points: ChartPoint[]; muted: boolean }[] = []
  for (let index = 1; index < points.length; index++) {
    const before = points[index - 1], after = points[index]
    const muted = rolling && before.muted && after.muted
    const prior = runs[runs.length - 1]
    if (prior && prior.muted === muted) prior.points.push(after)
    else runs.push({ points: [before, after], muted })
  }
  return runs
}
export function windowChange(chart: Chart, latestQuote?: Quote | null): string {
  const points = chartPoints(chart, latestQuote)
  return points.length < 2 ? "—" : changeLabel(points[0].price, points[points.length - 1].price)
}
const UNITS: readonly (readonly [bigint, string])[] = [[10n ** 12n, "T"], [10n ** 9n, "B"], [10n ** 6n, "M"]]
/** "$5.36T"-style: integer maths on the exact decimal, at most two decimals, no forced trailing zeros; below a million it is priceLabel. */
export function compactDollars(value: string | null): string {
  if (value === null) return "—"
  const units = scaled(value)
  if (units < 0n) return dollars(value)
  const index = UNITS.findIndex(([size]) => units >= size * 10n ** 18n)
  if (index === -1) { const plain = priceLabel(value); return plain === "$1,000,000" ? "$1M" : plain }
  const [size, suffix] = UNITS[index]
  const base = size * 10n ** 18n
  const hundredths = (units * 100n + base / 2n) / base
  // Rounding 999.995B up to 1,000B reads as the next unit: $1T.
  return hundredths >= 100_000n && index > 0 ? label(100n, UNITS[index - 1][1]) : label(hundredths, suffix)
}
function label(hundredths: bigint, suffix: string): string { const fraction = String(hundredths % 100n).padStart(2, "0").replace(/0+$/, ""); return `$${exact(String(hundredths / 100n))}${fraction ? `.${fraction}` : ""}${suffix}` }
/** First open, highest high and lowest low of the returned bars, compared exactly; null when there are none. */
export function barRange(chart: Chart): { open: string; high: string; low: string } | null {
  const bars = chart.range === "1D" && chart.fallback === "PREVIOUS_SESSION" ? chart.fallbackBars : chart.bars
  if (!bars.length) return null
  let high = bars[0].high, low = bars[0].low
  for (const bar of bars) { if (scaled(bar.high) > scaled(high)) high = bar.high; if (scaled(bar.low) < scaled(low)) low = bar.low }
  return { open: bars[0].open, high, low }
}
const AXIS_TIME = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
/** X-axis tick in New York time: MM/DD HH:mm for the intraday ranges (1D, 1W), MM/DD otherwise. */
export function axisTime(value: number, range: Range): string {
  const parts = AXIS_TIME.formatToParts(new Date(value))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? ""
  const date = `${part("month")}/${part("day")}`
  return range === "1D" || range === "1W" ? `${date} ${part("hour")}:${part("minute")}` : date
}
/** Y-axis tick: the plotted coordinate (already a Number at the plotting boundary) as a two-decimal priceLabel. */
export function axisPrice(value: number): string { return Number.isFinite(value) && value >= 0 ? priceLabel(value.toFixed(10)) : "" }
/**
 * Y-axis ticks for the plotted closes (Numbers at the plotting boundary only): a 1-2-5×10^n step of WHOLE cents spanning
 * the values, so every tick is exactly a two-decimal price and its axisPrice label is the gridline's own value (a library
 * "nice" step can fall between cents and round two gridlines to one label). Empty when there is nothing to plot.
 */
export function axisTicks(values: readonly number[], count = 5): number[] {
  const cents = values.filter(Number.isFinite).map(value => Math.round(value * 100))
  if (!cents.length) return []
  const low = Math.min(...cents), high = Math.max(...cents)
  const raw = Math.max(1, (high - low) / Math.max(1, count - 1))
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map(multiple => multiple * magnitude).find(candidate => candidate >= raw) ?? 10 * magnitude
  let start = Math.floor(low / step) * step, end = Math.ceil(high / step) * step
  if (start === end) { start = Math.max(0, start - step); end += step }
  const ticks: number[] = []
  // Integer cents throughout; the division by 100 happens once per tick.
  for (let cent = start; cent <= end; cent += step) ticks.push(cent / 100)
  return ticks
}

/** Estimated session turnover, not an exchange-reported sum of executions. Keep exact decimal arithmetic. */
export function volumeDollars(price: string | null, shares: string | null): string | null {
  if (price === null || shares === null) return null
  const units = scaled(price) * scaled(shares) / 10n ** 18n
  const fraction = String(units % (10n ** 18n)).padStart(18, "0").replace(/0+$/, "")
  return `${units / (10n ** 18n)}${fraction ? `.${fraction}` : ""}`
}

/** Feed coverage and latency are separate: IEX volume is never consolidated US volume. */
export function marketSourceLabel(response?: Pick<Envelope<unknown>, "provider" | "marketFeed">): string {
  if (response?.provider === "ALPACA") return response.marketFeed === "IEX" ? "Alpaca · IEX (single exchange)" : "Alpaca · SIP (US consolidated)"
  return "Massive"
}

/** Reported AUM takes precedence. Market-price capitalization is only an explicitly labelled proxy.
 * Massive supplies share-class outstanding units, not a dated NAV or weighted share count.
 */
export function assetSize(etf: boolean, profile: Profile | null | undefined, quote: Quote | null | undefined) {
  const reported = etf ? profile?.aum ?? null : profile?.marketCap ?? null
  if (reported !== null || !etf) return { value: reported, estimated: false, label: etf ? "AUM" : "Total Market Cap", title: `${etf ? "AUM" : "Market cap"}: ${dollars(reported)}${etf && profile?.aumAsOf ? ` · ${profile.aumAsOf}` : ""}${profile?.issuerFundamentals ? ` · Official ${profile.issuerFundamentals.source} data · ${profile.issuerFundamentals.sourceUrl}` : ""}` }
  const shares = profile?.sharesOutstanding ?? null
  const eligible = profile?.symbol === quote?.symbol && quote != null && (quote.status === "AVAILABLE" || quote.status === "STALE") && quote.sourceTimestamp != null && quote.price != null && scaled(quote.price) > 0n && shares != null && scaled(shares) > 0n
  const value = eligible ? volumeDollars(quote!.price, shares) : null
  return { value, estimated: value !== null, label: value === null ? "AUM" : "Estimated AUM", title: value === null ? "AUM: —" : `Estimated AUM: ${dollars(value)} · Shares outstanding ${exact(shares)} × market price ${dollars(quote!.price)} · Not official NAV-based AUM · Massive does not provide an as-of date for shares outstanding · Price observed: ${quote!.sourceTimestamp}${quote!.status === "STALE" ? " · Last observed price" : ""}` }
}

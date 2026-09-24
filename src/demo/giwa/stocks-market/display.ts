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
export const FEED_LABELS: Record<FeedDelay, string> = { UNKNOWN: "시세 지연 정보 미확인", DELAYED_15_MIN: "15분 지연", END_OF_DAY: "종가 기준", REALTIME: "실시간 피드 설정 · 관측 시각 확인" }
export function time(value: string | null): string { return value === null ? "—" : `${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(new Date(value))}` }
export function windowChange(chart: Chart): string {
  if (chart.bars.length < 2) return "—"
  const first = scaled(chart.bars[0].close), last = scaled(chart.bars[chart.bars.length - 1].close)
  // Exact integer arithmetic; round to two percentage decimals only for display.
  const numerator = (last - first) * 10_000n
  const magnitude = numerator < 0n ? -numerator : numerator
  const rounded = (magnitude + first / 2n) / first
  return `${numerator < 0n ? "−" : "+"}${rounded / 100n}.${String(rounded % 100n).padStart(2, "0")}%`
}
export function chartPoints(chart: Chart) {
  const width = chart.interval === "5m" ? 300000 : chart.interval === "1h" ? 3600000 : 86400000
  // Keep intraday gaps visible. Historical series should connect actual closes across
  // overnight, weekends and market holidays without synthesizing prices for closed sessions.
  // A gap longer than a normal long weekend remains disconnected.
  const gap = chart.interval === "5m" ? width * 3 : chart.interval === "1h" ? 4 * 86400000 : 5 * 86400000
  // Number conversion happens only here at the plotting boundary; labels retain original bars.
  let segment = 0
  return chart.bars.map((bar, index) => { const timestamp = Date.parse(bar.timestamp); if (index && timestamp - Date.parse(chart.bars[index - 1].timestamp) > gap) segment++; return { timestamp, coordinate: Number(bar.close), bar, segment, index } })
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
  if (!chart.bars.length) return null
  let high = chart.bars[0].high, low = chart.bars[0].low
  for (const bar of chart.bars) { if (scaled(bar.high) > scaled(high)) high = bar.high; if (scaled(bar.low) < scaled(low)) low = bar.low }
  return { open: chart.bars[0].open, high, low }
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
  if (reported !== null || !etf) return { value: reported, estimated: false, label: etf ? "AUM" : "Total Market Cap", title: `${etf ? "AUM" : "Market cap"}: ${dollars(reported)}${etf && profile?.aumAsOf ? ` · ${profile.aumAsOf}` : ""}${profile?.issuerFundamentals ? ` · ${profile.issuerFundamentals.source} 공식 자료 · ${profile.issuerFundamentals.sourceUrl}` : ""}` }
  const shares = profile?.sharesOutstanding ?? null
  const eligible = profile?.symbol === quote?.symbol && quote != null && (quote.status === "AVAILABLE" || quote.status === "STALE") && quote.sourceTimestamp != null && quote.price != null && scaled(quote.price) > 0n && shares != null && scaled(shares) > 0n
  const value = eligible ? volumeDollars(quote!.price, shares) : null
  return { value, estimated: value !== null, label: value === null ? "AUM" : "추정 AUM", title: value === null ? "AUM: —" : `추정 AUM: ${dollars(value)} · 발행 좌수 ${exact(shares)} × 시장가격 ${dollars(quote!.price)} · NAV 기준 공식 AUM 아님 · Massive 발행 좌수 기준일 미제공 · 가격 시각: ${quote!.sourceTimestamp}${quote!.status === "STALE" ? " · 마지막 확인 가격" : ""}` }
}

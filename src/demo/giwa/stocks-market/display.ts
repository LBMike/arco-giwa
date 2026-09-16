import type { Chart, FeedDelay } from "./contracts"
import { scaled } from "./validate"
export function exact(value: string | null): string { if (value === null) return "—"; const [whole, fraction = ""] = value.split("."); const trimmed = fraction.replace(/0+$/, ""); return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (trimmed ? `.${trimmed}` : "") }
export function dollars(value: string | null): string { return value === null ? "—" : `$${exact(value)}` }
/** Compact two-decimal UI label, rounded with integers; exact source remains in tooltip/table. */
export function priceLabel(value: string | null): string {
  if (value === null) return "—"
  const units = scaled(value), cent = 10n ** 16n
  const rounded = (units + cent / 2n) / cent
  const fraction = String(rounded % 100n).padStart(2, "0").replace(/0+$/, "")
  return `$${exact(String(rounded / 100n))}${fraction ? `.${fraction}` : ""}`
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
  // Number conversion happens only here at the plotting boundary; labels retain original bars.
  let segment = 0
  return chart.bars.map((bar, index) => { const timestamp = Date.parse(bar.timestamp); if (index && timestamp - Date.parse(chart.bars[index - 1].timestamp) > width + (chart.interval === "1d" ? 3600000 : 0)) segment++; return { timestamp, coordinate: Number(bar.close), bar, segment, index } })
}

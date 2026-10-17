// Number and date wording for the Savings page. Money follows the app rule: at most 2 decimals, no forced trailing
// zeros ("$1,000", "$6,975.45", "$2.5"). The live balance is the one place that always shows cents, followed by a few
// extra digits that tick with the yield (see balanceParts).

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const

/** "$1,234.5" — grouped, at most 2 decimals, no trailing zeros. "—" when not a number. */
export function usd(value: number): string {
  if (!Number.isFinite(value)) return "—"
  const sign = value < 0 ? "-" : ""
  return `${sign}$${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
}

/** A token amount: grouped, at most `maxDecimals` (cut, never rounded up), no trailing zeros. */
export function tokenAmount(value: number, maxDecimals = 4): string {
  if (!Number.isFinite(value)) return "—"
  const factor = 10 ** maxDecimals
  const cut = Math.trunc(value * factor) / factor
  return cut.toLocaleString("en-US", { maximumFractionDigits: maxDecimals })
}

/** A typed decimal with thousands separators, kept as typed otherwise: "1234.5" → "1,234.5", "0." → "0.". */
export function groupDigits(value: string): string {
  if (value === "") return ""
  const point = value.indexOf(".")
  const whole = point === -1 ? value : value.slice(0, point)
  const rest = point === -1 ? "" : value.slice(point)
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${rest}`
}

/** "$0", "$1.5K", "$12M": compact axis and summary labels. */
export function usdCompact(value: number): string {
  if (!Number.isFinite(value)) return "—"
  const abs = Math.abs(value)
  const trim = (n: number) => Number(n.toFixed(2)).toLocaleString("en-US", { maximumFractionDigits: 2 })
  if (abs >= 1_000_000_000) return `$${trim(value / 1_000_000_000)}B`
  if (abs >= 1_000_000) return `$${trim(value / 1_000_000)}M`
  if (abs >= 1_000) return `$${trim(value / 1_000)}K`
  return `$${trim(value)}`
}

export type BalanceParts = Readonly<{ whole: string; cents: string; tail: string }>

/**
 * The live balance split for display: "$19,750" + ".03" + "306". The cents are always shown; `tail` holds three more
 * digits that move as the yield accrues (decorative, cut not rounded so the cents never jump ahead).
 */
export function balanceParts(value: number): BalanceParts {
  const safe = Number.isFinite(value) && value > 0 ? value : 0
  const thousandths = Math.floor(safe * 100_000)
  const whole = Math.floor(thousandths / 100_000)
  const fraction = String(thousandths % 100_000).padStart(5, "0")
  return { whole: `$${whole.toLocaleString("en-US")}`, cents: `.${fraction.slice(0, 2)}`, tail: fraction.slice(2) }
}

/** "Oct 2029" */
export function monthLabel(date: Date): string {
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`
}

/** The first day of the month `months` after `start`'s month. */
export function addMonths(start: Date, months: number): Date {
  return new Date(start.getFullYear(), start.getMonth() + months, 1)
}

/** The simulation horizon while pointing at the chart: "7m", "3y", "3y 7m". */
export function horizonShort(months: number): string {
  const years = Math.floor(months / 12)
  const rest = months % 12
  if (years === 0) return `${rest}m`
  return rest === 0 ? `${years}y` : `${years}y ${rest}m`
}

/** The simulation horizon at rest: "5 years", "1 year". */
export function horizonLong(years: number): string {
  return years === 1 ? "1 year" : `${years} years`
}

/** "0x1234…abcd" */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
}

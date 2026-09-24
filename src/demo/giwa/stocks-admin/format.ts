// Exact, locale-independent formatting for the Stocks console. Amounts stay strings end to
// end: no Number/parseFloat conversion, no rounding, no cross-asset arithmetic.

/** Stock quantity base-unit scale — enforced by the server manifest (`quantityScale: 9`). */
export const QUANTITY_SCALE = 9
/** Test cash base-unit scale — enforced by the server manifest (`cashScale: 6`). */
export const CASH_SCALE = 6
/** Admin responses carry no cash symbol; this is the server's own reconciliation asset code. */
export const CASH_UNIT = "TEST_CASH"

const SIGNED_INTEGER = /^-?(0|[1-9]\d*)$/

function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

/**
 * Renders an integer base-unit string at `scale` decimals, exactly: thousands grouping,
 * trailing fractional zeros trimmed, nothing rounded. Returns null for malformed input.
 */
export function formatBaseUnits(value: string, scale: number): string | null {
  if (typeof value !== "string" || !SIGNED_INTEGER.test(value)) return null
  if (!Number.isInteger(scale) || scale < 0 || scale > 36) return null
  const negative = value.startsWith("-")
  const digits = negative ? value.slice(1) : value
  const padded = digits.padStart(scale + 1, "0")
  const whole = groupDigits(padded.slice(0, padded.length - scale))
  const fraction = scale > 0 ? padded.slice(padded.length - scale).replace(/0+$/, "") : ""
  const text = fraction ? `${whole}.${fraction}` : whole
  return negative && digits !== "0" ? `-${text}` : text
}

/** Groups an integer count string ("12345" → "12,345"); null when malformed. */
export function formatCount(value: string): string | null {
  return formatBaseUnits(value, 0)
}

/** Exact integer-string sum (counts only — never used for amounts of different assets). */
export function sumCounts(values: readonly string[]): string {
  let total = 0n
  for (const value of values) if (SIGNED_INTEGER.test(value)) total += BigInt(value)
  return total.toString()
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0")
}

/** "2026-09-17 04:05:06 UTC"; the raw input is returned unchanged when it is not a valid time. */
export function formatUtc(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  return formatUtcMs(ms)
}

export function formatUtcMs(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
}

/** Block timestamps arrive as decimal seconds strings. */
export function formatEpochSeconds(seconds: string | null): string | null {
  if (seconds === null || !/^(0|[1-9]\d{0,15})$/.test(seconds)) return null
  return formatUtcMs(Number(seconds) * 1000)
}

/** Compact duration "45s", "3m 12s", "2h 5m", "4d 3h". Negative input → null. */
export function formatDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** Elapsed time from `iso` to `now`; a future timestamp is reported, not hidden. */
export function formatElapsed(iso: string, now: number): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return "unknown"
  if (ms > now) return "in the future (clock skew)"
  return `${formatDuration(now - ms)} ago`
}

/** "0x1234…abcd" for long identifiers; short values are returned unchanged. */
export function shortId(value: string, head = 6, tail = 4): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value
}

// Exact decimal handling for Stocks quantities and cash amounts.
//
// Human input is a decimal STRING, sent to the server exactly as typed once it passes the
// server's own grammar. Server values are integer base-unit STRINGS with a known scale.
// Nothing here converts money or quantity to a JavaScript number: BigInt and string slicing only.

import type { BaseUnits } from "./types"

const HUMAN_DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/
const BASE_UNITS = /^(0|[1-9]\d*)$/
/** The server rejects base-unit results above 10^30 for input and stores at most 10^36. */
const MAX_INPUT_BASE_UNITS = 10n ** 30n
const MAX_STORED_DIGITS = 37

export type HumanDecimalCheck =
  | { ok: true; input: string; baseUnits: BaseUnits }
  | { ok: false; input: string; reason: "EMPTY" | "FORMAT" | "PRECISION" | "ZERO" | "TOO_LARGE" }

/** Mirrors server `units(value, scale)`: same grammar, precision, positivity and bound. */
export function parseHumanDecimal(input: string, scale: number): HumanDecimalCheck {
  if (input === "") return { ok: false, input, reason: "EMPTY" }
  if (input.length > 80 || !HUMAN_DECIMAL.test(input)) return { ok: false, input, reason: "FORMAT" }
  const [whole, fraction = ""] = input.split(".")
  if (fraction.length > scale) return { ok: false, input, reason: "PRECISION" }
  const value = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0") || "0")
  if (value === 0n) return { ok: false, input, reason: "ZERO" }
  if (value > MAX_INPUT_BASE_UNITS) return { ok: false, input, reason: "TOO_LARGE" }
  return { ok: true, input, baseUnits: value.toString() }
}

/** Keystroke filter: digits with at most one dot and at most `scale` fraction digits. */
export function isDecimalKeystroke(next: string, scale: number): boolean {
  if (next === "") return true
  if (!/^\d*\.?\d*$/.test(next) || next.length > 80) return false
  const dot = next.indexOf(".")
  return dot === -1 || next.length - dot - 1 <= scale
}

/** A signed integer base-unit string ("-4000000000"), never "-0". Used only where the server can report a deficit. */
export function isSignedBaseUnits(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_STORED_DIGITS + 1 && /^(0|-?[1-9]\d*)$/.test(value)
}

export function isBaseUnits(value: unknown): value is BaseUnits {
  return typeof value === "string" && value.length <= MAX_STORED_DIGITS && BASE_UNITS.test(value)
}

/** Exact decimal rendering of integer base units: "120000001" @6 → "120.000001"; trailing zeros trimmed. */
export function formatBaseUnits(value: BaseUnits, scale: number, options: { group?: boolean } = {}): string {
  if (!isBaseUnits(value)) throw new Error("INVALID_BASE_UNITS")
  const padded = value.padStart(scale + 1, "0")
  const whole = padded.slice(0, padded.length - scale).replace(/^0+(?=\d)/, "")
  const fraction = scale === 0 ? "" : padded.slice(padded.length - scale).replace(/0+$/, "")
  const shownWhole = options.group ? groupThousands(whole) : whole
  return fraction === "" ? shownWhole : `${shownWhole}.${fraction}`
}

/** Exact rendering of a signed base-unit string: "-4000000000" @9 → "-4". */
export function formatSignedBaseUnits(value: string, scale: number, options: { group?: boolean } = {}): string {
  if (!isSignedBaseUnits(value)) throw new Error("INVALID_BASE_UNITS")
  return value.startsWith("-") ? `-${formatBaseUnits(value.slice(1), scale, options)}` : formatBaseUnits(value, scale, options)
}

/** Canonical human decimal (e.g. catalog price "120.000000") → trimmed exact display. */
export function formatHumanDecimal(value: string, options: { group?: boolean } = {}): string {
  if (!HUMAN_DECIMAL.test(value)) throw new Error("INVALID_DECIMAL")
  const [whole, fraction = ""] = value.split(".")
  const trimmed = fraction.replace(/0+$/, "")
  const shownWhole = options.group ? groupThousands(whole) : whole
  return trimmed === "" ? shownWhole : `${shownWhole}.${trimmed}`
}

export function isHumanDecimal(value: unknown, maxScale: number): value is string {
  if (typeof value !== "string" || value.length > 80 || !HUMAN_DECIMAL.test(value)) return false
  const fraction = value.split(".")[1] ?? ""
  return fraction.length <= maxScale
}

export function groupThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

export function addBaseUnits(a: BaseUnits, b: BaseUnits): BaseUnits {
  return (BigInt(a) + BigInt(b)).toString()
}

/** a − b; null when the result would be negative. */
export function subtractBaseUnits(a: BaseUnits, b: BaseUnits): BaseUnits | null {
  const result = BigInt(a) - BigInt(b)
  return result < 0n ? null : result.toString()
}

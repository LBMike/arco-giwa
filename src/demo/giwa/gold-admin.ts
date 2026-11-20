import type { PauseRow } from "./arcousd-admin"
import type { GiwaArcoGoldReserve, GiwaArcoGoldSavings } from "./types"

// Pure helpers for the admin Gold page (AdminGold.tsx): number formatting, the pause lists and the
// reserve's cover. The page is read-only: it shows what the two public ArcoGOLD reads answer.

type GoldReserveState = NonNullable<GiwaArcoGoldReserve["reserve"]>
type GoldVaultState = NonNullable<GiwaArcoGoldSavings["savings"]>

/** Ounces: up to 4 decimals, no forced trailing zeros (a troy ounce is a large unit: 0.0083 oz would
 *  read "0.01"). "—" when not a number. */
export function ouncesText(value: string | number | null | undefined): string {
  const amount = typeof value === "number" ? value : Number(value)
  if (value === null || value === undefined || value === "" || !Number.isFinite(amount)) return "—"
  return amount.toLocaleString("en-US", { maximumFractionDigits: 4 })
}

/** "12.5 oz" / "—". */
export function ouncesLabel(value: string | number | null | undefined): string {
  const text = ouncesText(value)
  return text === "—" ? text : `${text} oz`
}

/** The display rate: "4%" (max 2 decimals, no forced trailing zeros); "Not set" without one. */
export function goldApyText(apyPercent: number | null | undefined): string {
  if (apyPercent === null || apyPercent === undefined || !Number.isFinite(apyPercent)) return "Not set"
  return `${Number(apyPercent.toFixed(2))}%`
}

/** Where the ounce price came from, in words. */
export function ounceSourceLabel(source: string | null | undefined): string {
  if (source === "coingecko:pax-gold") return "PAX Gold on CoinGecko"
  if (source === "kraken:paxg") return "PAX Gold on Kraken (fallback)"
  return source || "—"
}

export type GoldCover = {
  /** backing − liabilities, in ounces. */
  readonly surplusOunces: number
  /** The reserve holds at least what it owes. */
  readonly covered: boolean
}

/** The gold Reserve's cover from its two totals; null when either is not a number. */
export function goldCover(reserve: Pick<GoldReserveState, "totalBackingOunces" | "totalLiabilitiesOunces">): GoldCover | null {
  const backing = Number(reserve.totalBackingOunces)
  const liabilities = Number(reserve.totalLiabilitiesOunces)
  if (!Number.isFinite(backing) || !Number.isFinite(liabilities)) return null
  const surplusOunces = backing - liabilities
  return { surplusOunces, covered: surplusOunces >= 0 }
}

export type GoldLiquidity = {
  /** Coins the Reserve holds now, in ounces (1 coin = 1 troy ounce). */
  readonly bufferOunces: number
  /** Backing held outside the buffer, in strategies. Gold has none, so this is 0 unless that changes. */
  readonly deployedOunces: number
  /** Buffer coins already owed to the Standard queue. */
  readonly queuedOunces: number
  /** What Instant withdrawals can take now: the buffer less the queue, coin by coin. */
  readonly instantOunces: number
  /** Buffer and strategies as shares of the backing, 0–100; null with no backing. */
  readonly bufferPercent: number | null
  readonly deployedPercent: number | null
}

function sumOf(values: ReadonlyArray<string | number | null | undefined>): number {
  return values.reduce<number>((total, value) => {
    const amount = Number(value)
    return Number.isFinite(amount) ? total + amount : total
  }, 0)
}

/** How the gold Reserve's backing splits between the coin buffer and strategies, and what is payable at once. */
export function goldLiquidity(reserve: Pick<GoldReserveState, "totalBackingOunces" | "assets">): GoldLiquidity {
  const backing = Number(reserve.totalBackingOunces)
  const bufferOunces = sumOf(reserve.assets.map((asset) => asset.balanceHuman))
  const queuedOunces = sumOf(reserve.assets.map((asset) => asset.queuedHuman))
  const instantOunces = sumOf(reserve.assets.map((asset) => asset.availableHuman))
  const hasBacking = Number.isFinite(backing) && backing > 0
  const deployedOunces = hasBacking ? Math.max(backing - bufferOunces, 0) : 0
  const bufferPercent = hasBacking ? Math.min((bufferOunces / backing) * 100, 100) : null
  return {
    bufferOunces,
    deployedOunces,
    queuedOunces,
    instantOunces,
    bufferPercent,
    deployedPercent: bufferPercent === null ? null : 100 - bufferPercent,
  }
}

/** A share of the backing: "100%", "62.5%"; "—" without one. */
export function sharePercentText(percent: number | null | undefined): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return "—"
  return `${Number(percent.toFixed(2))}%`
}

/** Basis points as a percent ("10000" → "100%"); "—" when the server did not send one. */
export function bpsPercentText(bps: number | null | undefined): string {
  return bps === null || bps === undefined || !Number.isFinite(bps) ? "—" : sharePercentText(bps / 100)
}

/** A wait in seconds, in words: "10 minutes", "1 hour", "45 seconds"; "—" without one. */
export function waitText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—"
  const unit = (count: number, name: string) => `${Number(count.toFixed(1))} ${name}${count === 1 ? "" : "s"}`
  if (seconds < 60) return unit(seconds, "second")
  if (seconds < 3600) return unit(seconds / 60, "minute")
  if (seconds < 86400) return unit(seconds / 3600, "hour")
  return unit(seconds / 86400, "day")
}

/** ArcoXAU that can still be issued under the mint cap, in ounces; null without a cap. */
export function mintHeadroomOunces(reserve: Pick<GoldReserveState, "mintCap" | "totalLiabilities">): number | null {
  if (!reserve.mintCap) return null
  try {
    const left = BigInt(reserve.mintCap) - BigInt(reserve.totalLiabilities)
    // Whole ounces and the remainder separately, so a large cap keeps its fraction.
    const base = 10n ** 18n
    return left <= 0n ? 0 : Number(left / base) + Number(left % base) / 1e18
  } catch {
    return null
  }
}

/** The ArcoGOLD vault's switches, in the order a saver meets them. */
export function goldVaultPauseRows(vault: GoldVaultState): PauseRow[] {
  return [
    { label: "ArcoGOLD deposit", paused: vault.depositPaused, effect: "Deposits and mints" },
    { label: "ArcoGOLD withdraw", paused: vault.withdrawPaused, effect: "Withdrawals and redemptions" },
    { label: "ArcoGOLD (all)", paused: vault.vaultPaused, effect: "Every vault function" },
  ]
}

/** The gold Reserve's and the ounce unit's switches. */
export function goldReservePauseRows(reserve: GoldReserveState): PauseRow[] {
  return [
    { label: "Reserve deposit", paused: reserve.depositPaused, effect: "Coins in: minting ounces for a deposit" },
    { label: "Reserve redeem", paused: reserve.redeemPaused, effect: "Coins out: every redemption" },
    { label: "Reserve instant redeem", paused: reserve.redeemInstantOnlyPaused, effect: "Instant redemptions only" },
    { label: "ArcoXAU mint", paused: reserve.arcoUSDMintPaused, effect: "Deposits (mint)" },
    { label: "ArcoXAU burn", paused: reserve.arcoUSDBurnPaused, effect: "Redemptions (burn)" },
    ...(reserve.settlementPaused === undefined ? [] : [{ label: "Settlement", paused: reserve.settlementPaused, effect: "Paying the Standard queue" }]),
    ...(reserve.queuePaused === undefined ? [] : [{ label: "Standard queue", paused: reserve.queuePaused, effect: "New queued withdrawals" }]),
    { label: "Reserve (all)", paused: reserve.reservePaused, effect: "Every Reserve function" },
    { label: "ArcoXAU (all)", paused: reserve.arcoUSDPaused, effect: "Mint and burn (transfers continue)" },
  ]
}

export type GoldHeadline = { readonly tone: "positive" | "negative" | "attention" | "neutral"; readonly label: string; readonly detail: string }

/** One line for the top of the page: is the gold account taking deposits and paying withdrawals? */
export function goldHeadline(savings: GiwaArcoGoldSavings | null | undefined): GoldHeadline {
  if (!savings) return { tone: "neutral", label: "Loading", detail: "Reading ArcoGOLD" }
  if (savings.status === "not-deployed") return { tone: "neutral", label: "Not deployed", detail: "The ArcoGOLD registry file is not on this server" }
  if (savings.status !== "live" || !savings.savings) return { tone: "negative", label: "Unavailable", detail: "ArcoGOLD could not be read" }
  const { depositsOpen, withdrawalsOpen, seeded } = savings.savings
  if (depositsOpen && withdrawalsOpen) return { tone: "positive", label: "Open", detail: "Deposits and withdrawals are open" }
  if (!seeded) return { tone: "attention", label: "Not seeded", detail: "Deposits open once ArcoGOLD is seeded" }
  if (!depositsOpen && !withdrawalsOpen) return { tone: "negative", label: "Paused", detail: "Deposits and withdrawals are paused" }
  return depositsOpen
    ? { tone: "attention", label: "Withdrawals paused", detail: "Deposits are open; withdrawals are paused" }
    : { tone: "attention", label: "Deposits paused", detail: "Withdrawals are open; deposits are paused" }
}

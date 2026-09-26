// Previews for the customer trade panel at the price on screen (the chart's live NVDA price), mirroring the server's quote
// formulas in server/src/stocks/pricing.ts. The server's quote is always what is paid or received; these only preview it.
// Prices are tUSDC base units (6 decimals) per whole NVDA; quantities are NVDA base units (9 decimals). BigInt only.

/** Buy fee in basis points of the payment, and Sell fee in basis points of the sale's value. 0 for now, as on the server. */
export const MINT_FEE_BPS = 0n
export const BURN_FEE_BPS = 0n

const BPS = 10_000n
const UNIT = 1_000_000_000n
const PRICE = /^(0|[1-9]\d{0,9})(\.\d{1,18})?$/

/** tUSDC a Buy of `quantity` costs: its value at `price` plus the mint fee, rounded up. */
export function buyCost(quantity: bigint, price: bigint, feeBps: bigint = MINT_FEE_BPS): bigint {
  const net = BPS - feeBps
  return (quantity * price * BPS + net * UNIT - 1n) / (net * UNIT)
}

/** NVDA an exact tUSDC payment buys: the payment less the mint fee, at `price`, rounded down. */
export function buyQuantity(cash: bigint, price: bigint, feeBps: bigint = MINT_FEE_BPS): bigint {
  return (cash * (BPS - feeBps) * UNIT) / (BPS * price)
}

/** tUSDC a Sell of `quantity` pays: its value at `price` less the burn fee, rounded down. */
export function sellPayout(quantity: bigint, price: bigint, feeBps: bigint = BURN_FEE_BPS): bigint {
  return (quantity * price * (BPS - feeBps)) / (BPS * UNIT)
}

/** tUSDC for one whole NVDA at `price`: what a Buy of 1 NVDA costs or a Sell of 1 NVDA pays, fees included. */
export function perShareCash(side: "BUY" | "SELL", price: bigint): bigint {
  return side === "SELL" ? sellPayout(UNIT, price) : buyCost(UNIT, price)
}

/** A market or catalog price ("223.71", "120.000000") as tUSDC base units, rounded half up; null when it is not a positive price. */
export function priceUnits(value: string | null | undefined): bigint | null {
  if (typeof value !== "string" || !PRICE.test(value)) return null
  const [whole, fraction = ""] = value.split(".")
  let units = BigInt(whole) * 1_000_000n + BigInt(fraction.slice(0, 6).padEnd(6, "0"))
  if (fraction.length > 6 && fraction[6] >= "5") units += 1n
  return units > 0n ? units : null
}

/** Basis points as a percentage: 0n → "0%", 10n → "0.1%", 25n → "0.25%". */
export function formatFee(bps: bigint): string {
  const whole = bps / 100n
  const fraction = (bps % 100n).toString().padStart(2, "0").replace(/0+$/, "")
  return fraction === "" ? `${whole}%` : `${whole}.${fraction}%`
}

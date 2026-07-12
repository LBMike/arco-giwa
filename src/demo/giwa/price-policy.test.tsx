import assert from "node:assert/strict"
import test from "node:test"
import {
  SECONDS_PER_DAY,
  computeNavPrice,
  computeQuote,
  elapsedDays,
  formatPriceDelta,
  fromAnswer,
  impliedAprPercent,
  impliedApyPercent,
  isStale,
  marketApyPercent,
  marketApyText,
  navSharePrice,
  navSharePriceValue,
  priceChange24hPct,
  toAnswer,
  validateAnswer,
} from "./price-policy"

test("computeNavPrice divides NAV by shares outstanding (payment-asset per share)", () => {
  assert.equal(computeNavPrice({ nav: 1002000, shares: 1000000 }), 1.002)
  assert.equal(toAnswer(computeNavPrice({ nav: 1002000, shares: 1000000 })), 100200000n)
  // a 1:1 NAV reproduces the baseline answer (1e8)
  assert.equal(toAnswer(computeNavPrice({ nav: 1000000, shares: 1000000 })), 100000000n)
})

test("computeNavPrice guards against zero/negative/NaN shares", () => {
  assert.throws(() => computeNavPrice({ nav: 1000, shares: 0 }), /shares/)
  assert.throws(() => computeNavPrice({ nav: 1000, shares: -5 }), /shares/)
  assert.throws(() => computeNavPrice({ nav: 1000, shares: Number.NaN }), /shares/)
})

test("implied APY/APR are derived from the price change over the period", () => {
  const basePrice = 1
  const newPrice = 1.002
  const periodDays = 7
  const apr = impliedAprPercent({ basePrice, newPrice, periodDays })
  const apy = impliedApyPercent({ basePrice, newPrice, periodDays })
  // APR is simple (linear) annualization — independent literal, not a transcendental constant
  assert.ok(apr !== null && Math.abs(apr - 10.42857142857) < 1e-6, `apr was ${apr}`)
  // APY recomputed with the same compounding formula (tolerance), not a hand-typed constant
  assert.ok(
    apy !== null && Math.abs(apy - (((newPrice / basePrice) ** (365 / periodDays)) - 1) * 100) < 1e-9,
    `apy was ${apy}`,
  )
  // compounding beats simple annualization for positive growth
  assert.ok((apy as number) > (apr as number))
})

test("implied APY/APR return null when basePrice<=0 or periodDays<=0 (incl. NaN)", () => {
  assert.equal(impliedApyPercent({ basePrice: 0, newPrice: 1.002, periodDays: 7 }), null)
  assert.equal(impliedAprPercent({ basePrice: 1, newPrice: 1.002, periodDays: 0 }), null)
  assert.equal(impliedApyPercent({ basePrice: 1, newPrice: 1.002, periodDays: -3 }), null)
  assert.equal(impliedAprPercent({ basePrice: 1, newPrice: 1.002, periodDays: Number.NaN }), null)
})

test("computeQuote: invest divides pay by price, redeem multiplies", () => {
  assert.equal(computeQuote({ payAmount: 1, price: 1, side: "invest" }), 1)
  assert.equal(computeQuote({ payAmount: 1, price: 1, side: "redeem" }), 1)
  assert.equal(computeQuote({ payAmount: 10, price: 2, side: "invest" }), 5)
  assert.equal(computeQuote({ payAmount: 10, price: 2, side: "redeem" }), 20)
  assert.equal(computeQuote({ payAmount: 1, price: 1.002, side: "redeem" }), 1.002)
  const invest = computeQuote({ payAmount: 1, price: 1.002, side: "invest" })
  assert.ok(invest !== null && Math.abs(invest - 1 / 1.002) < 1e-12, `got ${invest}`)
  assert.ok(invest !== null && Math.abs(invest - 0.998004) < 1e-6) // ~0.998
})

test("computeQuote returns null for non-positive / non-finite inputs", () => {
  assert.equal(computeQuote({ payAmount: 1, price: 0, side: "invest" }), null)
  assert.equal(computeQuote({ payAmount: 0, price: 1, side: "invest" }), null)
  assert.equal(computeQuote({ payAmount: Number(""), price: 1, side: "invest" }), null) // blank -> 0
  assert.equal(computeQuote({ payAmount: Number.NaN, price: 1, side: "redeem" }), null)
  assert.equal(computeQuote({ payAmount: 1, price: -1, side: "redeem" }), null)
  assert.equal(computeQuote({ payAmount: 1, price: Number.POSITIVE_INFINITY, side: "invest" }), null)
})

test("toAnswer rounds half-up and round-trips with fromAnswer at 8 decimals", () => {
  assert.equal(toAnswer(1), 100000000n)
  assert.equal(toAnswer(1.000000005), 100000001n) // exact .5 -> rounds up
  assert.equal(toAnswer(1.000000004), 100000000n) // below .5 -> rounds down
  assert.equal(fromAnswer(100000000n), 1)
  assert.equal(toAnswer(fromAnswer(100200000n)), 100200000n)
})

test("toAnswer rejects non-finite prices", () => {
  assert.throws(() => toAnswer(Number.NaN), /finite/)
  assert.throws(() => toAnswer(Number.POSITIVE_INFINITY), /finite/)
})

test("isStale mirrors the contract boundary (fresh at ==healthyDiff, stale at +1)", () => {
  const updatedAt = 1_000_000
  const healthyDiff = 3600
  assert.equal(isStale({ updatedAt, healthyDiff, now: updatedAt + healthyDiff }), false)
  assert.equal(isStale({ updatedAt, healthyDiff, now: updatedAt + healthyDiff + 1 }), true)
  assert.equal(isStale({ updatedAt, healthyDiff, now: updatedAt + healthyDiff - 1 }), false)
  // accepts bigint chain values too
  assert.equal(isStale({ updatedAt: 1_000_000n, healthyDiff: 3600n, now: 1_003_601 }), true)
})

test("elapsedDays converts a seconds delta into fractional days", () => {
  assert.equal(elapsedDays(0, 7 * 86_400), 7)
  assert.equal(elapsedDays(1_000_000n, 1_000_000 + 86_400 / 2), 0.5)
})

test("marketApyText = apy ?? impliedApy (mirrors the list); '—' when both null", () => {
  // Registered vault: no published rate → implied-from-posts value shows (e.g. bEQTY 13.09%).
  assert.equal(marketApyText({ apy: null, impliedApy: 13.09 }), "13.09%")
  // Built-in with a published rate: static apy wins, implied ignored (byte-identical).
  assert.equal(marketApyText({ apy: 11.58, impliedApy: 5 }), "11.58%")
  // Trims trailing zeros to the 2-decimal rule.
  assert.equal(marketApyText({ apy: 6, impliedApy: null }), "6%")
  assert.equal(marketApyText({ apy: 6.284, impliedApy: null }), "6.28%")
  // Truly none (<2 posts, no published rate) → em dash, never a fabricated APY.
  assert.equal(marketApyText({ apy: null, impliedApy: null }), "—")
  assert.equal(marketApyText(null), "—")
})

test("navSharePrice shows up to 4 decimals (min 2) so near-par NAV movement is visible", () => {
  assert.equal(navSharePrice(1.00163636), "$1.0016") // live posted NAV, not rounded to $1.00
  assert.equal(navSharePrice(1), "$1.00") // par keeps the 2-decimal floor
  assert.equal(navSharePrice(1.000025), "$1.00") // sub-4dp movement → unchanged (built-ins near par)
  assert.equal(navSharePrice(1.002), "$1.002") // no forced trailing zeros
  assert.equal(navSharePrice(60123.456), "$60,123.456") // large values keep the thousands separator
})

test("navSharePriceValue is the same 2–4dp rule without the currency prefix (navBase isn't USD)", () => {
  assert.equal(navSharePriceValue(1.00163636), "1.0016")
  assert.equal(navSharePriceValue(1), "1.00")
  assert.equal(navSharePrice(1.0016), `$${navSharePriceValue(1.0016)}`) // one formatting rule, two callers
})

test("priceChange24hPct compares now against the latest point at/before now−24h", () => {
  const now = 1_000_000
  const pct = priceChange24hPct([
    { t: now - 3 * SECONDS_PER_DAY, navBase: 0.5 }, // older point must not win
    { t: now - SECONDS_PER_DAY, navBase: 1.0 }, // exactly 24h back → the baseline (at-or-before)
    { t: now - SECONDS_PER_DAY / 2, navBase: 1.0002 }, // inside the window → not the baseline
    { t: now, navBase: 1.0004 },
  ])
  assert.ok(Math.abs((pct as number) - 0.04) < 1e-9) // (1.0004 − 1.0) / 1.0 × 100
})

test("priceChange24hPct is negative when the share price fell, and handles unsorted points", () => {
  const now = 1_000_000
  assert.equal(priceChange24hPct([{ t: now, navBase: 1.0 }, { t: now - SECONDS_PER_DAY, navBase: 2.0 }]), -50)
})

test("priceChange24hPct: null with NO history; 0% when history has no point ≥24h back", () => {
  const now = 1_000_000
  assert.equal(priceChange24hPct([]), null) // no history at all → column renders "—"
  assert.equal(priceChange24hPct([{ t: now - 100, navBase: 1.0 }, { t: now, navBase: 2.0 }]), 0)
})

test("formatPriceDelta signs the change; zero (and anything rounding to zero) reads as up", () => {
  assert.deepEqual(formatPriceDelta(0.04), { text: "+0.04%", up: true })
  assert.deepEqual(formatPriceDelta(-0.04), { text: "-0.04%", up: false })
  assert.deepEqual(formatPriceDelta(0), { text: "0%", up: true }) // exactly 0% → "0%", up colour
  assert.deepEqual(formatPriceDelta(-0.0001), { text: "0%", up: true }) // never renders "-0%"
  assert.deepEqual(formatPriceDelta(1.5), { text: "+1.5%", up: true }) // no forced trailing zeros
})

test("validateAnswer enforces >0 and the inclusive [min, max] feed bounds", () => {
  const bounds = { min: 1n, max: 100_000_000_000_000n } // deployed GIWA bounds (1 .. 1e14)
  assert.equal(validateAnswer(0n, bounds).ok, false)
  assert.equal(validateAnswer(1n, bounds).ok, true)
  assert.equal(validateAnswer(100_000_000n, bounds).ok, true)
  assert.equal(validateAnswer(100_000_000_000_000n, bounds).ok, true) // inclusive upper bound
  const over = validateAnswer(100_000_000_000_001n, bounds)
  assert.equal(over.ok, false)
  assert.match(over.reason ?? "", /exceeds the feed maximum/)
})

test("marketApyPercent = apy ?? impliedApy ?? null — same source as marketApyText, but numeric", () => {
  assert.equal(marketApyPercent({ apy: 5.6, impliedApy: 2 }), 5.6) // published rate wins
  assert.equal(marketApyPercent({ apy: null, impliedApy: 3.14 }), 3.14) // falls back to implied
  assert.equal(marketApyPercent({ apy: null, impliedApy: null }), null)
  assert.equal(marketApyPercent(null), null)
  // Consistency: the numeric source matches what marketApyText formats (rounded) for display.
  assert.equal(marketApyText({ apy: 5.6, impliedApy: 2 }), "5.6%")
})

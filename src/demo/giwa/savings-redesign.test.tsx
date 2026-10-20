// The Savings page redesign: the pure rules (simulation, treemap, backing, amounts, wording) and the static markup of
// its sections. The full-screen deposit / withdraw flow is portalled, so its rules are tested through savings-transfer.

import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { AllocationTreemap, BackingCard, cardPlacement, sliceValue } from "./AllocationTreemap"
import type { SavingsAccount } from "./savings"
import { RollingDigits } from "./RollingDigits"
import { SavingsAccordion } from "./SavingsAccordion"
import { SAVINGS_BACKING, SAVINGS_POWERED_BY, reserveAssetLabel, savingsBacking, savingsDepositLabel, savingsExposure } from "./savings-backing"
import {
  balanceParts,
  groupDigits,
  horizonLong,
  horizonShort,
  monthLabel,
  rollingAmount,
  rollingDecimals,
  tokenAmount,
  usd,
  usdCompact,
} from "./savings-format"
import { SavingsHeroCard, type SavingsHeroProps } from "./SavingsHeroCard"
import { niceTicks, simulateSavings } from "./savings-simulation"
import { SavingsSimulation } from "./SavingsSimulation"
import { SavingsStatsRow, sparklinePath } from "./SavingsStatsRow"
import { SavingsTabs } from "./SavingsTabs"
import {
  amountForPercent,
  exceedsBalance,
  operationMatchesMode,
  pendingWithdrawals,
  percentOfBalance,
  redemptionTimelineText,
  sanitizeAmountInput,
  transferCta,
} from "./savings-transfer"
import { squarify } from "./savings-treemap"
import type { GiwaRedemption } from "./types"
import { easeOutCubic, rollingValue } from "./useRollingNumber"

const near = (actual: number, expected: number, tolerance = 0.01) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`)

// ── simulation ────────────────────────────────────────────────────────────

test("simulation: one point per month for five years, deposits counted per frequency", () => {
  const base = { apyPercent: 0, startingBalance: 0, initialDeposit: 1000, recurringDeposit: 500 }
  const monthly = simulateSavings({ ...base, frequency: "monthly" })
  assert.equal(monthly.length, 61)
  assert.deepEqual([monthly[0]!.month, monthly[60]!.month], [0, 60])
  assert.equal(monthly[60]!.contributed, 1000 + 500 * 60)
  assert.equal(simulateSavings({ ...base, frequency: "weekly" })[60]!.contributed, 1000 + 500 * 260)
  assert.equal(simulateSavings({ ...base, frequency: "daily" })[60]!.contributed, 1000 + 500 * 1825)
  // At 0% nothing is earned and the balance is what went in.
  assert.equal(monthly[60]!.earned, 0)
  assert.equal(monthly[60]!.balance, monthly[60]!.contributed)
})

test("simulation: a lump sum grows by exactly the APY each year", () => {
  const points = simulateSavings({ apyPercent: 3.8, startingBalance: 0, initialDeposit: 1000, recurringDeposit: 0, frequency: "monthly" })
  near(points[12]!.balance, 1038)
  near(points[60]!.earned, 1000 * (1.038 ** 5 - 1))
})

test("simulation: a balance already held earns too and counts as put in", () => {
  const withBalance = simulateSavings({ apyPercent: 3.8, startingBalance: 18_750, initialDeposit: 1000, recurringDeposit: 0, frequency: "monthly" })
  near(withBalance[60]!.earned, 19_750 * (1.038 ** 5 - 1))
  assert.equal(withBalance[0]!.contributed, 19_750)
})

test("simulation: monthly deposits earn less than the same amount deposited on day one", () => {
  const recurring = simulateSavings({ apyPercent: 5, startingBalance: 0, initialDeposit: 0, recurringDeposit: 100, frequency: "monthly" })[60]!
  const lump = simulateSavings({ apyPercent: 5, startingBalance: 0, initialDeposit: 6000, recurringDeposit: 0, frequency: "monthly" })[60]!
  assert.ok(recurring.earned > 0 && recurring.earned < lump.earned)
})

test("niceTicks: round steps from 0 past the top", () => {
  assert.deepEqual(niceTicks(7180, 8), [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000])
  assert.deepEqual(niceTicks(3131, 6), [0, 1000, 2000, 3000, 4000])
  assert.deepEqual(niceTicks(0), [0])
})

// ── treemap ───────────────────────────────────────────────────────────────

test("squarify: tiles cover the box, sized by value, larger first", () => {
  const items = SAVINGS_BACKING.map((slice) => ({ id: slice.id, value: slice.percent }))
  for (const aspect of [2.4, 0.75]) {
    const tiles = squarify(items, aspect)
    assert.equal(tiles.length, 5)
    near(tiles.reduce((sum, tile) => sum + tile.w * tile.h, 0), 1, 1e-9)
    for (const tile of tiles) {
      const value = items.find((item) => item.id === tile.id)!.value
      near(tile.w * tile.h, value / 100, 1e-9)
      assert.ok(tile.x >= -1e-9 && tile.y >= -1e-9 && tile.x + tile.w <= 1 + 1e-9 && tile.y + tile.h <= 1 + 1e-9)
    }
    // No two tiles overlap.
    for (const a of tiles) {
      for (const b of tiles) {
        if (a === b) continue
        const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        assert.ok(overlapW <= 1e-9 || overlapH <= 1e-9, `${a.id} overlaps ${b.id}`)
      }
    }
  }
  // Wide box: the largest slice is a full-height column on the left.
  const wide = squarify(items, 2.4)[0]!
  assert.equal(wide.id, "fidelity")
  near(wide.x, 0, 1e-9)
  near(wide.h, 1, 1e-9)
})

test("squarify: nothing to lay out gives no tiles; non-positive values are skipped", () => {
  assert.deepEqual(squarify([], 2), [])
  assert.deepEqual(squarify([{ id: "a", value: 0 }], 2), [])
  assert.deepEqual(squarify([{ id: "a", value: 1 }, { id: "b", value: -1 }], 2).map((tile) => tile.id), ["a"])
})

// ── backing ───────────────────────────────────────────────────────────────

test("backing: the published allocation adds up to 100 and names its three managers", () => {
  assert.equal(SAVINGS_BACKING.reduce((sum, slice) => sum + slice.percent, 0), 100)
  assert.deepEqual(
    SAVINGS_BACKING.map((slice) => [slice.label, slice.percent]),
    [["Fidelity", 40], ["UBS", 20], ["Franklin Templeton", 10], ["Crypto & RWA-backed loans", 20], ["Instant liquidity reserve", 10]],
  )
  assert.deepEqual(SAVINGS_POWERED_BY.map((mark) => mark.name), ["Fidelity", "Franklin Templeton", "UBS", "Morpho"])
  // Every logo file is in public/, so none falls back to its initial.
  for (const mark of SAVINGS_POWERED_BY) assert.ok(existsSync(new URL(`../../../public${mark.logo}`, import.meta.url)), mark.logo)
})

test("exposure: the backing grouped by asset type, the reserve in the vault's own coin", () => {
  assert.deepEqual(
    savingsExposure("tUSDC").map((slice) => [slice.label, slice.percent]),
    [["U.S. Treasury & money market funds", 70], ["Crypto & RWA-backed loans", 20], ["USDC instant reserve", 10]],
  )
  assert.equal(savingsExposure("tWETH")[2]!.label, "ETH instant reserve")
  assert.deepEqual(["tUSDC", "tWETH", "tXRP", "tBTC", "USDC"].map(reserveAssetLabel), ["USDC", "ETH", "XRP", "BTC", "USDC"])
})

test("deposit label: the stablecoin account invites Stablecoins, the others their coin", () => {
  assert.deepEqual(["tUSDC", "USDC", "tWETH", "tXRP"].map(savingsDepositLabel), ["Stablecoins", "Stablecoins", "ETH", "XRP"])
})

// ── amounts and the main button ───────────────────────────────────────────

test("amount input: digits and one point, capped decimals, no leading zeros", () => {
  assert.equal(sanitizeAmountInput("00012.345678", 2), "12.34")
  assert.equal(sanitizeAmountInput(".", 6), "0.")
  assert.equal(sanitizeAmountInput("1.2.3", 6), "1.23")
  assert.equal(sanitizeAmountInput("abc", 6), "")
  assert.equal(sanitizeAmountInput("7.", 0), "7")
})

test("amount input: a decimal comma is a decimal point, thousands commas are dropped", () => {
  // Typed on a keypad set to a decimal-comma locale.
  assert.equal(sanitizeAmountInput("1,5", 6), "1.5")
  assert.equal(sanitizeAmountInput("12,34", 6), "12.34")
  assert.equal(sanitizeAmountInput("1,", 6), "1.")
  // Pasted grouped amounts.
  assert.equal(sanitizeAmountInput("1,000", 6), "1000")
  assert.equal(sanitizeAmountInput("1,234,567", 6), "1234567")
  assert.equal(sanitizeAmountInput("1,000.5", 6), "1000.5")
  assert.equal(sanitizeAmountInput(" 2 500 ", 6), "2500")
})

test("withdraw helpers: the hook's operation kind, this product's pending withdrawals, the settlement time", () => {
  assert.equal(operationMatchesMode("deposit", "deposit"), true)
  assert.equal(operationMatchesMode("redeemInstant", "deposit"), false)
  assert.equal(operationMatchesMode("redeemInstant", "withdraw"), true)
  assert.equal(operationMatchesMode("requestRedeem", "withdraw"), true)
  assert.equal(operationMatchesMode("deposit", "withdraw"), false)
  const row = (productId: string, status: string, requestId = "1") =>
    ({ requestId, productId, walletAddress: "0x1", redemptionVaultAddress: "0x2", sharesIn: "1", lockedAssetsOut: "0", status }) as GiwaRedemption
  const rows = [row("arcousd", "REQUESTED", "1"), row("aeth", "REQUESTED", "2"), row("arcousd", "SETTLED", "3"), row("ARCOUSD", "settling", "4")]
  assert.deepEqual(pendingWithdrawals(rows, "arcousd").map((item) => item.requestId), ["1", "4"])
  // A malformed row (no product / status) is skipped rather than breaking the screen.
  assert.deepEqual(pendingWithdrawals([{ requestId: "9" } as unknown as GiwaRedemption, ...rows], "arcousd").length, 2)
  assert.equal(redemptionTimelineText(3), "3 Days")
  assert.equal(redemptionTimelineText(null), "30-90 Business Days")
})

test("percent shortcuts: MAX spends the exact balance, shares are cut, the slider follows the amount", () => {
  assert.equal(amountForPercent("1000.123456", 100, 6), "1000.123456")
  assert.equal(amountForPercent("1000", 25, 6), "250")
  assert.equal(amountForPercent("0.000001", 50, 6), "")
  assert.equal(amountForPercent("--", 50, 6), "")
  assert.equal(amountForPercent("10", 33.33, 18, 4), "3.333")
  assert.equal(percentOfBalance("250", "1000", 6), 25)
  assert.equal(percentOfBalance("2000", "1000", 6), 100)
  assert.equal(percentOfBalance("1", "--", 6), 0)
  assert.equal(exceedsBalance("1000.000001", "1000", 6), true)
  assert.equal(exceedsBalance("1000", "1000", 6), false)
})

test("main button: wallet prerequisites first, then the amount, then Review", () => {
  const base = { amount: "10", balance: "100", decimals: 6, paused: false }
  assert.deepEqual(transferCta({ ...base, phase: "disconnected" }), { label: "Connect Wallet", action: "connect", disabled: false })
  assert.deepEqual(transferCta({ ...base, phase: "wrong-network" }), { label: "Switch to GIWA", action: "switch-network", disabled: false })
  assert.equal(transferCta({ ...base, phase: "missing-gas" }).action, "faucet")
  assert.equal(transferCta({ ...base, phase: "approving" }).disabled, true)
  assert.equal(transferCta({ ...base, phase: "ready", paused: true }).label, "Temporarily unavailable")
  assert.equal(transferCta({ ...base, phase: "ready", amount: "" }).label, "Enter an Amount")
  assert.equal(transferCta({ ...base, phase: "ready", amount: "0" }).label, "Enter an Amount")
  assert.equal(transferCta({ ...base, phase: "ready", amount: "101" }).label, "Insufficient Balance")
  assert.deepEqual(transferCta({ ...base, phase: "allowance-required" }), { label: "Review", action: "review", disabled: false })
  // Until the hook holds this screen's operation, nothing can be reviewed or sent.
  assert.deepEqual(transferCta({ ...base, phase: "ready", synced: false }), { label: "Processing the transaction", action: null, disabled: true })
  assert.equal(transferCta({ ...base, phase: "disconnected", synced: false }).action, "connect")
})

// ── wording ───────────────────────────────────────────────────────────────

test("format: money keeps at most two decimals, the live balance always shows cents and three more digits", () => {
  assert.equal(usd(6975.45), "$6,975.45")
  assert.equal(usd(1000), "$1,000")
  assert.equal(usd(Number.NaN), "—")
  assert.equal(usdCompact(5_200_000_000), "$5.2B")
  assert.equal(usdCompact(2500), "$2.5K")
  assert.equal(usdCompact(0), "$0")
  assert.deepEqual(balanceParts(19750.0330699), { whole: "$19,750", cents: ".03", tail: "306" })
  assert.deepEqual(balanceParts(0), { whole: "$0", cents: ".00", tail: "000" })
  assert.equal(tokenAmount(999.80003999), "999.8")
  assert.deepEqual([horizonShort(7), horizonShort(36), horizonShort(43)], ["7m", "3y", "3y 7m"])
  assert.equal(horizonLong(5), "5 years")
  assert.equal(monthLabel(new Date(2029, 9, 1)), "Oct 2029")
  assert.deepEqual(["", "0.", "1234.5", "1000000", "12.3456"].map(groupDigits), ["", "0.", "1,234.5", "1,000,000", "12.3456"])
})

test("rolling balance: decimals kept in place while it rolls, at least two, as many as the final figure shows", () => {
  assert.deepEqual([0, 1000, 999.80003999, 0.5, 0.12345, 1234.5678].map((value) => rollingDecimals(value)), [2, 2, 2, 2, 4, 4])
  assert.equal(rollingAmount(0, 2), "0.00")
  assert.equal(rollingAmount(999.80003999, 2), "999.80")
  assert.equal(rollingAmount(1000, 2), "1,000.00")
  assert.equal(rollingAmount(523.1789, 2), "523.17", "cut, never rounded up")
  assert.equal(rollingAmount(0.12345, 4), "0.1234")
  assert.equal(rollingAmount(Number.NaN, 2), "—")
})

test("rolling balance: eases out from the figure shown to the new one, landing exactly on it", () => {
  assert.equal(easeOutCubic(0), 0)
  assert.equal(easeOutCubic(1), 1)
  assert.equal(easeOutCubic(2), 1)
  assert.ok(easeOutCubic(0.5) > 0.5, "fast at first")
  assert.equal(rollingValue(0, 1000, 0, 900), 0)
  assert.equal(rollingValue(0, 1000, 900, 900), 1000)
  assert.equal(rollingValue(0, 1000, 5000, 900), 1000)
  assert.equal(rollingValue(1000, 0, 450, 900), 125, "a withdrawal rolls down the same way")
  assert.equal(rollingValue(3, 7, 10, 0), 7)
})

test("rolling digits: one clipped slot per character; they roll in only when asked, the way the figure moved", () => {
  const still = renderToStaticMarkup(<RollingDigits text="1,234.5" trend="up" />)
  assert.equal(still.split("[clip-path:inset(0)]").length - 1, 7)
  assert.equal(still.replace(/<[^>]+>/g, ""), "1,234.5")
  assert.doesNotMatch(still, /savings-digit-/)
  assert.match(still, /^<span aria-hidden="true"/, "decorative: the figure's text is given beside it")
  const entering = renderToStaticMarkup(<RollingDigits text="99.8" trend="up" enter />)
  assert.equal(entering.split("savings-digit-in-up").length - 1, 4, "every digit rolls in from below")
  assert.match(renderToStaticMarkup(<RollingDigits text="5" trend="down" enter />), /savings-digit-in-down/)
  // The motion lives in the theme, and stops under reduced motion (the leaving digits are hidden outright).
  const theme = readFileSync(new URL("../theme.css", import.meta.url), "utf8")
  for (const name of ["in-up", "out-up", "in-down", "out-down"]) assert.match(theme, new RegExp(`@keyframes savings-digit-${name} \\{`), name)
  const reduced = theme.slice(theme.lastIndexOf("@media (prefers-reduced-motion: reduce)"))
  assert.match(reduced, /\.savings-digit-in-up,\s*\.arco-demo \.savings-digit-in-down \{ animation: none; \}/)
  assert.match(reduced, /\.savings-digit-out-up,\s*\.arco-demo \.savings-digit-out-down \{ display: none; \}/)
})

test("sparkline: a step line across the box ending at the latest value", () => {
  assert.equal(sparklinePath([{ ts: 1, value: 4 }]), null)
  const path = sparklinePath([{ ts: 0, value: 3 }, { ts: 10, value: 4 }])!
  assert.match(path.d, /^M0 36\.00 H400\.00 V4\.00 H400$/)
  assert.deepEqual(path.end, { x: 400, y: 4 })
})

// ── markup ────────────────────────────────────────────────────────────────

const heroProps = (over: Partial<SavingsHeroProps> = {}): SavingsHeroProps => ({
  connected: false,
  depositLabel: "Stablecoins",
  tokenSymbol: "arcoUSD",
  tokenIcon: "/logos/arco.png",
  paySymbol: "USDC",
  payIcon: "/logos/usdc.svg",
  balanceUsd: null,
  shares: null,
  available: null,
  availableUsd: null,
  apyPercent: 4.79,
  onDeposit: () => undefined,
  onWithdraw: () => undefined,
  ...over,
})

test("savings card before a wallet: the invitation, the features and who the reserves are held with", () => {
  const html = renderToStaticMarkup(<SavingsHeroCard {...heroProps()} />)
  assert.match(html, /Deposit Stablecoins/)
  assert.match(html, /and start /)
  assert.match(html, />saving</)
  assert.match(html, /Institution-grade backing/)
  // Four slides; the onchain-settlement one is gone.
  assert.match(html, /aria-label="1 of 4"/)
  assert.doesNotMatch(html, /Settled onchain on GIWA/)
  assert.match(html, /Powered by/)
  // Logos only, in order, each named for screen readers; no names written out.
  const logos = [...html.matchAll(/<img src="([^"]+)" alt="([^"]+)"/g)].map((match) => [match[2], match[1]])
  assert.deepEqual(logos.filter(([name]) => ["Fidelity", "Franklin Templeton", "UBS", "Morpho"].includes(name!)), [
    ["Fidelity", "/logos/powered-by/fidelity.png"],
    ["Franklin Templeton", "/logos/powered-by/franklin.png"],
    ["UBS", "/logos/umint.svg"],
    ["Morpho", "/logos/powered-by/morpho.png"],
  ])
  // Round badges, each after the first tucked half under the one before it (28px badges, 14px overlap), the first on
  // top; the one pointed at comes to the front.
  const stack = [...html.matchAll(/<li class="([^"]*)" style="--stack-z:(\d+)">/g)].map((match) => [match[1]!.split(" "), Number(match[2])] as const)
  assert.deepEqual(stack.map(([, z]) => z), [4, 3, 2, 1])
  for (const [index, [classes]] of stack.entries()) {
    for (const token of ["group/logo", "z-[var(--stack-z)]", "hover:z-10"]) assert.ok(classes.includes(token), `${token} on logo ${index}`)
    assert.equal(classes.includes("-ml-3.5"), index > 0, `logo ${index} overlap`)
    // The pointer area itself never moves.
    assert.ok(!classes.some((token) => token.includes("translate")), `logo ${index} stays put`)
  }
  // The badge pointed at lifts and grows a little; the badges before it move left and those after it right.
  const unescape = (value: string) => value.replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  const badges = [...html.matchAll(/<span class="(flex size-7 [^"]*)">/g)].map((match) => unescape(match[1]!).split(" "))
  assert.equal(badges.length, 4)
  for (const classes of badges) {
    for (const token of [
      "rounded-[var(--radius-pill)]",
      "ring-2",
      "group-hover/logo:-translate-y-1",
      "group-hover/logo:scale-110",
      "[li:hover~li>&]:translate-x-2",
      "[li:has(~li:hover)>&]:-translate-x-2",
    ]) {
      assert.ok(classes.includes(token), token)
    }
  }
  // Each name is written once, in its logo's label above it: hidden until pointed at, and kept from screen readers
  // (the logo's alt already names the partner).
  const names = ["Fidelity", "Franklin Templeton", "UBS", "Morpho"]
  const labels = [...html.matchAll(/<span aria-hidden="true" class="([^"]*)">([^<]+)<\/span>/g)].filter((match) => names.includes(match[2]!))
  assert.deepEqual(labels.map((match) => match[2]), names)
  for (const match of labels) {
    for (const token of ["invisible", "opacity-0", "group-hover/logo:visible", "group-hover/logo:opacity-100"]) assert.ok(match[1]!.split(" ").includes(token), token)
  }
  for (const name of names) assert.equal(html.split(`>${name}<`).length - 1, 1, `${name} written once`)
  // The arcoUSD mark: larger and on no disc of its own.
  assert.match(html, /<span class="flex items-center gap-2\.5"><img src="\/logos\/arco\.png" alt="arcoUSD" title="arcoUSD" width="40" height="40"/)
  assert.match(html, />arcoUSD</)
  assert.doesNotMatch(html, /Savings Balance/)
  assert.doesNotMatch(html, />Deposit</)
})

test("savings card with a wallet: balance, coins available, Deposit and Withdraw", () => {
  const html = renderToStaticMarkup(
    <SavingsHeroCard {...heroProps({ connected: true, balanceUsd: 1234.56789, shares: 1234.31, available: 500, availableUsd: 500 })} />,
  )
  assert.match(html, /Savings Balance/)
  assert.match(html, /<span class="sr-only">\$1,234\.57<\/span>/)
  // The figure rolls digit by digit: one clipped slot per character ($1,234 · .56 · 789), still reading the same, and
  // nothing rolls when it is first shown.
  assert.ok(html.replace(/<[^>]+>/g, "").includes("$1,234.56789"))
  assert.equal(html.split("[clip-path:inset(0)]").length - 1, 12)
  assert.doesNotMatch(html, /savings-digit-/)
  assert.match(html, /1,234\.31 arcoUSD/)
  // The token mark beside the shares and the wallet coin beside what is available: each its own mark on no disc, with
  // the card's hairline.
  assert.match(html, /tabular-nums"><img src="\/logos\/arco\.png" alt="arcoUSD" title="arcoUSD" width="24" height="24"/)
  assert.match(html, /<img src="\/logos\/usdc\.svg" alt="USDC" title="USDC" width="20" height="20" class="shrink-0 object-contain ring-1 ring-\[var\(--color-savings-on-hero-line\)\]"/)
  assert.doesNotMatch(html, /style="width:20px;height:20px"><img/)
  assert.match(html, />Earning</)
  // What the wallet can deposit is named as the headline names it: Stablecoins here, the coin elsewhere.
  assert.match(html, /Available Stablecoins/)
  assert.match(html, /The stablecoins in your connected wallet that you can deposit\./)
  assert.doesNotMatch(html, /Available USDC/)
  assert.match(renderToStaticMarkup(<SavingsHeroCard {...heroProps({ connected: true, depositLabel: "ETH", paySymbol: "tWETH" })} />), /Available ETH/)
  assert.match(html, /\$500/)
  assert.match(html, />Deposit<\/button>/)
  assert.match(html, />Withdraw<\/button>/)
  // No balance yet: no Earning chip, and the figure reads just $0.00 (the ticking digits wait for a balance).
  const empty = renderToStaticMarkup(<SavingsHeroCard {...heroProps({ connected: true, balanceUsd: 0, shares: 0 })} />)
  assert.doesNotMatch(empty, />Earning</)
  const emptyFigure = empty.replace(/<[^>]+>/g, "")
  assert.ok(emptyFigure.includes("$0.00") && !emptyFigure.includes("$0.00000"), emptyFigure)
  assert.equal(empty.split("[clip-path:inset(0)]").length - 1, 5, "$0 · .00")
})

test("savings card look: the navy card by default, black with cream lines and light for Crypto Native", () => {
  for (const connected of [false, true]) {
    const blue = renderToStaticMarkup(<SavingsHeroCard {...heroProps({ connected })} />)
    assert.match(blue, /data-savings-tone="blue"/)
    assert.match(blue, /linear-gradient\(135deg, var\(--color-arco-hero-deco-1\)/)
    const cream = renderToStaticMarkup(<SavingsHeroCard {...heroProps({ connected, tone: "cream" })} />)
    assert.match(cream, /data-savings-tone="cream"/)
    assert.match(cream, /style="background-color:var\(--color-arco-hero\)"/)
  }
  // The cream look re-scopes the card's lines, panels and aurora to the brand cream (--color-arco-cream).
  const theme = readFileSync(new URL("../theme.css", import.meta.url), "utf8")
  const scope = theme.slice(theme.indexOf('[data-savings-tone="cream"] {'))
  const block = scope.slice(0, scope.indexOf("}"))
  for (const name of ["on-hero-line", "on-hero-fill", "aurora-1", "aurora-2", "aurora-3", "aurora-4"]) {
    assert.match(block, new RegExp(`--color-savings-${name}: rgba\\(225, 224, 204, `), name)
  }
})

const account = (symbol: string, over: Partial<SavingsAccount> = {}): SavingsAccount => ({
  key: `real:v-${symbol}:${symbol}`,
  symbol,
  icon: `/accept/${symbol}.png`,
  apy: "4.79%",
  disabled: false,
  vault: null,
  vaultId: `v-${symbol}`,
  sortOrder: null,
  ...over,
})

test("tabs: Stablecoins stacks its coins in one tab; Crypto Native has a chip per coin", () => {
  const accounts = [account("USDC"), account("RLUSD"), account("ETH", { apy: "3.86%" }), account("XRP", { disabled: true })]
  const html = renderToStaticMarkup(<SavingsTabs accounts={accounts} selectedKey={accounts[2]!.key} onSelect={() => undefined} />)
  assert.match(html, /Stablecoins/)
  // Every coin the deposit and withdraw screens take, with the marks they show, though the Vault Config lists two.
  assert.match(html, /<span class="sr-only">USDC, USDT, RLUSD, ArcoUSD<\/span>/)
  const stack = html.slice(0, html.indexOf('<span class="sr-only">'))
  assert.deepEqual(
    [...stack.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1]),
    ["/logos/usdc.svg", "/logos/usdt.png", "/logos/rlusd.png", "/logos/arcousd.png"],
  )
  // The marks overlap with no ring around them (no white behind a coin), the first on top.
  assert.doesNotMatch(stack, /ring-/)
  assert.deepEqual([...stack.matchAll(/style="z-index:(\d+)"/g)].map((match) => Number(match[1])), [4, 3, 2, 1])
  assert.match(html, /Crypto Native/)
  assert.match(html, /aria-pressed="true"[^>]*>.*?ETH.*?3\.86%/)
  assert.match(html, /aria-pressed="false"[^>]*disabled=""[^>]*>.*?XRP.*?Soon/)
})

test("tabs: a stablecoin the Vault Config lists beyond those trails the stack with its own mark", () => {
  const html = renderToStaticMarkup(
    <SavingsTabs accounts={[account("USDC"), account("PYUSD", { disabled: true }), account("usdt")]} selectedKey={null} onSelect={() => undefined} />,
  )
  // One mark per coin: the configured usdt is the USDT already stacked.
  assert.match(html, /<span class="sr-only">USDC, USDT, RLUSD, ArcoUSD, PYUSD<\/span>/)
  assert.match(html, /<img src="\/logos\/arcousd\.png"[^>]*><\/span><span [^>]*><img src="\/accept\/PYUSD\.png"/)
  // No stablecoin account, no Stablecoins tab.
  assert.doesNotMatch(renderToStaticMarkup(<SavingsTabs accounts={[account("ETH")]} selectedKey={null} onSelect={() => undefined} />), /Stablecoins/)
})

test("accordion: closed rows show their summary; the open one shows its content", () => {
  const sections = [
    { id: "backing", title: "Backing", icon: null, summary: "Backing assets: $1M", content: <p>backing body</p> },
    { id: "simulation", title: "Simulation", icon: null, summary: null, content: <p>simulation body</p> },
  ]
  const closed = renderToStaticMarkup(<SavingsAccordion sections={sections} />)
  assert.match(closed, /aria-expanded="false"/)
  assert.match(closed, /Backing assets: \$1M/)
  assert.doesNotMatch(closed, /backing body/)
  const open = renderToStaticMarkup(<SavingsAccordion sections={sections} initialOpen="backing" />)
  assert.match(open, /aria-expanded="true"[^>]*>.*?Backing/)
  assert.match(open, /backing body/)
  assert.doesNotMatch(open, /simulation body/)
})

test("treemap: every slice named with its share, managers with their logos", () => {
  const html = renderToStaticMarkup(<AllocationTreemap slices={SAVINGS_BACKING} title="Backing assets" info="x" total="$1.2M" />)
  assert.match(html, /\$1\.2M/)
  for (const slice of SAVINGS_BACKING) {
    assert.match(html, new RegExp(`>${slice.label.replace(/[&]/g, "&amp;")}</span>`))
    assert.match(html, new RegExp(`>${slice.percent}%</span>`))
  }
  assert.match(html, /fidelity\.png/)
  assert.match(html, /umint\.svg/)
  // Without details (the Exposure tiles) a tile only names itself on hover, natively, and takes no focus.
  assert.match(html, /title="Fidelity · 40%"/)
  assert.doesNotMatch(html, /tabindex=/)
})

test("backing details: who manages each slice, what it is held in (as DigiFT names it) and on which chain", () => {
  const backing = savingsBacking({ symbol: "USDC", icon: "/logos/usdc.svg" })
  assert.deepEqual(backing.map((slice) => [slice.id, slice.percent]), SAVINGS_BACKING.map((slice) => [slice.id, slice.percent]))
  const rows = backing.map((slice) => [slice.id, slice.detail?.manager.role, slice.detail?.manager.name, slice.detail?.asset.name, slice.detail?.asset.symbol])
  assert.deepEqual(rows, [
    ["fidelity", "Asset manager", "Fidelity", "Reserve-Grade US Treasury Strategy Token", "RRDY"],
    ["ubs", "Asset manager", "UBS", "UBS (SG) Global Opportunities VCC - UBS Money Market (USD)", "uMINT"],
    ["franklin-templeton", "Asset manager", "Franklin Templeton", "Franklin OnChain Institutional Liquidity Fund", "iBENJI"],
    ["loans", "Protocol", "Morpho", "Crypto & RWA-backed loans", null],
    ["reserve", "Asset manager", "Arco", "Instant liquidity reserve", "USDC"],
  ])
  // The fund tokens' own marks; every asset is issued on Ethereum; every mark is a file in public/.
  assert.deepEqual(backing.map((slice) => slice.detail?.asset.logo), ["/logos/rrdy.png", "/logos/umint.svg", "/logos/ibenji.svg", null, "/logos/usdc.svg"])
  for (const slice of backing) {
    assert.equal(slice.detail?.chain.name, "Ethereum")
    for (const logo of [slice.detail?.manager.logo, slice.detail?.asset.logo, slice.detail?.chain.logo]) {
      if (logo) assert.ok(existsSync(new URL(`../../../public${logo}`, import.meta.url)), logo)
    }
  }
  // The reserve is held in the account's own coin.
  const ethBacking = savingsBacking({ symbol: "ETH", icon: "/logos/aeth.png" })
  assert.equal(ethBacking[ethBacking.length - 1]?.detail?.asset.symbol, "ETH")
})

test("backing card: the asset's name, then its manager, the token, chain, value and share; placed beside its tile", () => {
  const slice = savingsBacking({ symbol: "USDC", icon: null })[0]!
  const html = renderToStaticMarkup(<BackingCard id="card" slice={slice} detail={slice.detail!} value={sliceValue(slice.percent, 50_000)} />)
  assert.match(html, /role="tooltip"/)
  // The title is the asset's name alone; its ticker (with the token's mark) is the Asset row, under the manager.
  const text = html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|")
  assert.equal(text, "|Reserve-Grade US Treasury Strategy Token|Asset manager|Fidelity|Asset|RRDY|Chain|Ethereum|Allocation|$20K|Share|40%|")
  assert.match(html, /src="\/logos\/rrdy\.png"/)
  assert.match(html, /src="\/logos\/powered-by\/fidelity\.png"/)
  assert.match(html, /src="\/logos\/ethereum\.svg"/)
  assert.equal(sliceValue(10, null), null)
  // The loans have no mark of their own: the card shows Morpho's.
  const loans = savingsBacking({ symbol: "USDC", icon: null })[3]!
  const loansCard = renderToStaticMarkup(<BackingCard id="card" slice={loans} detail={loans.detail!} value="$10K" />)
  assert.match(loansCard, /^<div[^>]*>(?:(?!<dl).)*src="\/logos\/powered-by\/morpho\.png"/s)
  // They hold no token of their own, so no Asset row.
  assert.doesNotMatch(loansCard, />Asset</)
  // Beside the tile on its right when there is room, else on its left, else over it inside the grid.
  assert.deepEqual(cardPlacement({ left: 0, top: 10, width: 300, height: 200 }, 900), { left: 308, top: 10 })
  assert.deepEqual(cardPlacement({ left: 600, top: 0, width: 300, height: 100 }, 900), { left: 304, top: 0 })
  assert.deepEqual(cardPlacement({ left: 20, top: 40, width: 300, height: 100 }, 340), { left: 28, top: 48 })
  // In a grid with details, the tiles take focus and leave the naming to the card.
  const grid = renderToStaticMarkup(<AllocationTreemap slices={savingsBacking({ symbol: "USDC", icon: null })} title="Backing assets" info="x" total={null} />)
  assert.match(grid, /tabindex="0"/)
  assert.doesNotMatch(grid, /title="Fidelity · 40%"/)
})

test("simulation section: earnings and balance over five years at the APY", () => {
  const expected = simulateSavings({ apyPercent: 4.79, startingBalance: 0, initialDeposit: 1000, recurringDeposit: 500, frequency: "monthly" })[60]!
  const html = renderToStaticMarkup(<SavingsSimulation apyPercent={4.79} startingBalance={0} maxDeposit={null} />)
  assert.match(html, /Earn over 5 years/)
  assert.match(html, new RegExp(usd(expected.earned).replace(/[$.]/g, "\\$&")))
  assert.match(html, new RegExp(usd(expected.balance).replace(/[$.]/g, "\\$&")))
  assert.doesNotMatch(html, />MAX</)
  assert.match(renderToStaticMarkup(<SavingsSimulation apyPercent={4.79} startingBalance={0} maxDeposit={250} />), />MAX</)
  assert.match(renderToStaticMarkup(<SavingsSimulation apyPercent={null} startingBalance={0} maxDeposit={null} />), /The APY is not known yet/)
})

test("figures row: APY and TVL", () => {
  const html = renderToStaticMarkup(<SavingsStatsRow apyText="4.79%" history={undefined} tvlText="$12.4K" />)
  assert.match(html, />4\.79%</)
  assert.match(html, />TVL/)
  assert.match(html, />\$12\.4K</)
  assert.match(html, /APY Details/)
  assert.doesNotMatch(html, /Users/)
})

test("savings card: with several coins to deposit, what is available is their total, the coins held stacked beside it", () => {
  const html = renderToStaticMarkup(
    <SavingsHeroCard
      {...heroProps({
        connected: true,
        available: 9_000,
        availableUsd: 29_005,
        availableCoins: [
          { icon: "/logos/rlusd.png", symbol: "RLUSD" },
          { icon: "/logos/usdc.svg", symbol: "USDC" },
        ],
      })}
    />,
  )
  assert.match(html, /\$29,005/)
  const stack = html.slice(html.indexOf("data-coin-stack"))
  assert.deepEqual([...stack.matchAll(/<img src="([^"]+)" alt="([^"]+)"/g)].map((match) => [match[2], match[1]]), [
    ["RLUSD", "/logos/rlusd.png"],
    ["USDC", "/logos/usdc.svg"],
  ])
  // Tucked under each other, the first on top, with no dark ring around them; the pay coin's own mark is not repeated.
  assert.match(stack, /<span class="relative inline-flex -ml-1\.5" style="z-index:1">/)
  assert.doesNotMatch(stack, /ring-2|color-arco-hero/)
  assert.equal(html.split('width="20"').length - 1, 2)
  // A single coin held: its own mark, no stack. None held: the pay coin's own mark, as before.
  const one = renderToStaticMarkup(
    <SavingsHeroCard {...heroProps({ connected: true, available: 0, availableUsd: 10_000, availableCoins: [{ icon: "/logos/usdt.png", symbol: "USDT" }] })} />,
  )
  assert.doesNotMatch(one, /data-coin-stack/)
  assert.match(one, /<img src="\/logos\/usdt\.png" alt="USDT" title="USDT" width="20" height="20"/)
  assert.doesNotMatch(one, /alt="USDC"/)
  const none = renderToStaticMarkup(<SavingsHeroCard {...heroProps({ connected: true, available: 500, availableUsd: 500, availableCoins: [] })} />)
  assert.doesNotMatch(none, /data-coin-stack/)
  assert.match(none, /<img src="\/logos\/usdc\.svg" alt="USDC" title="USDC" width="20" height="20"/)
})

test("savings card: the Earning dot beats like a heart with a halo fading out of it, and stays still under reduced motion", () => {
  const html = renderToStaticMarkup(<SavingsHeroCard {...heroProps({ connected: true, balanceUsd: 100, shares: 99.98 })} />)
  assert.match(
    html,
    /<span aria-hidden="true" class="relative inline-flex size-1\.5 shrink-0"><span class="savings-heartbeat-halo absolute inset-0 [^"]*"><\/span><span class="savings-heartbeat-dot relative [^"]*"><\/span><\/span>Earning/,
  )
  // Nothing beats before there is a balance (no Earning chip).
  assert.doesNotMatch(renderToStaticMarkup(<SavingsHeroCard {...heroProps({ connected: true, balanceUsd: 0, shares: 0 })} />), /savings-heartbeat/)
  const theme = readFileSync(new URL("../theme.css", import.meta.url), "utf8")
  assert.match(theme, /\.savings-heartbeat-dot \{\s*transform-origin: center;\s*animation: savings-heartbeat-dot 1\.6s ease-in-out infinite;/)
  assert.match(theme, /@keyframes savings-heartbeat-dot \{/)
  assert.match(theme, /@keyframes savings-heartbeat-halo \{/)
  const reduced = theme.slice(theme.lastIndexOf("@media (prefers-reduced-motion: reduce)"))
  assert.match(reduced, /\.savings-heartbeat-dot,\s*\.arco-demo \.savings-heartbeat-halo,/)
  assert.match(reduced, /\.savings-heartbeat-halo \{ opacity: 0; \}/)
})

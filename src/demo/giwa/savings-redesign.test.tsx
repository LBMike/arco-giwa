// The Savings page redesign: the pure rules (simulation, treemap, backing, amounts, wording) and the static markup of
// its sections. The full-screen deposit / withdraw flow is portalled, so its rules are tested through savings-transfer.

import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { AllocationTreemap } from "./AllocationTreemap"
import type { SavingsAccount } from "./savings"
import { SavingsAccordion } from "./SavingsAccordion"
import { SAVINGS_BACKING, SAVINGS_POWERED_BY, reserveAssetLabel, savingsExposure } from "./savings-backing"
import { balanceParts, groupDigits, horizonLong, horizonShort, monthLabel, tokenAmount, usd, usdCompact } from "./savings-format"
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
  assert.deepEqual(SAVINGS_POWERED_BY.map((mark) => mark.name), ["Fidelity", "UBS", "Franklin Templeton"])
})

test("exposure: the backing grouped by asset type, the reserve in the vault's own coin", () => {
  assert.deepEqual(
    savingsExposure("tUSDC").map((slice) => [slice.label, slice.percent]),
    [["U.S. Treasury & money market funds", 70], ["Crypto & RWA-backed loans", 20], ["USDC instant reserve", 10]],
  )
  assert.equal(savingsExposure("tWETH")[2]!.label, "ETH instant reserve")
  assert.deepEqual(["tUSDC", "tWETH", "tXRP", "tBTC", "USDC"].map(reserveAssetLabel), ["USDC", "ETH", "XRP", "BTC", "USDC"])
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

test("sparkline: a step line across the box ending at the latest value", () => {
  assert.equal(sparklinePath([{ ts: 1, value: 4 }]), null)
  const path = sparklinePath([{ ts: 0, value: 3 }, { ts: 10, value: 4 }])!
  assert.match(path.d, /^M0 36\.00 H400\.00 V4\.00 H400$/)
  assert.deepEqual(path.end, { x: 400, y: 4 })
})

// ── markup ────────────────────────────────────────────────────────────────

const heroProps = (over: Partial<SavingsHeroProps> = {}): SavingsHeroProps => ({
  connected: false,
  depositLabel: "USDC",
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
  assert.match(html, /Deposit USDC/)
  assert.match(html, /and start /)
  assert.match(html, />saving</)
  assert.match(html, /Institution-grade backing/)
  assert.match(html, /Powered by/)
  for (const name of ["Fidelity", "UBS", "Franklin Templeton"]) assert.match(html, new RegExp(`>${name}<`))
  assert.match(html, /franklin-templeton\.png/)
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
  assert.match(html, /\$1,234<\/span><span[^>]*>\.56<\/span><span[^>]*>789<\/span>/)
  assert.match(html, /1,234\.31 arcoUSD/)
  assert.match(html, />Earning</)
  assert.match(html, /Available USDC/)
  assert.match(html, /\$500/)
  assert.match(html, />Deposit<\/button>/)
  assert.match(html, />Withdraw<\/button>/)
  // No balance yet: no Earning chip.
  assert.doesNotMatch(renderToStaticMarkup(<SavingsHeroCard {...heroProps({ connected: true, balanceUsd: 0, shares: 0 })} />), />Earning</)
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
  assert.match(html, /<span class="sr-only">USDC, RLUSD<\/span>/)
  assert.match(html, /Crypto Native/)
  assert.match(html, /aria-pressed="true"[^>]*>.*?ETH.*?3\.86%/)
  assert.match(html, /aria-pressed="false"[^>]*disabled=""[^>]*>.*?XRP.*?Soon/)
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

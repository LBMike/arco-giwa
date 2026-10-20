import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  fundPayChoices,
  payAssetForOption,
  payAssetLogo,
  payAssetOptionKey,
  RESERVE_REFILL_NOTICE,
  stablecoinSwapFee,
  stablecoinSwapFeeTip,
  type PayAssetOption,
} from "./arcousd-buy"
import { GiwaInvestPanel, withReserveTestAssets } from "./components"
import type { GiwaCatalogItem } from "./types"

// ArcoRouter fund buys in the invest panel: the "You pay" token chip (it opens the Savings token picker), the selected
// asset's balance, and the buy gate notice. Without Router props the panel is unchanged. The stablecoin swap fee sits in
// the Transaction Fees breakdown (fund-pay-picker.dom.test.tsx opens it).

const product: GiwaCatalogItem = {
  productId: "umint",
  symbol: "uMINT",
  name: "Arco uMINT",
  paymentAssetSymbol: "tUSDC",
  paymentAsset: {
    symbol: "tUSDC",
    name: "Test USDC",
    decimals: 6,
    contract: { proxy: "0x00000000000000000000000000000000000000a1" },
    faucet: "0x00000000000000000000000000000000000000f1",
  },
  paymentAssetAddress: "0x00000000000000000000000000000000000000A1",
  productTokenAddress: "0x00000000000000000000000000000000000000b1",
  depositVaultAddress: "0x00000000000000000000000000000000000000c1",
  redemptionVaultAddress: "0x00000000000000000000000000000000000000d1",
  priceFeedAddress: "0x00000000000000000000000000000000000000e1",
} as unknown as GiwaCatalogItem

const option = (label: string, symbol: string, n: number, decimals: number, swapFeeBps: number, isArcoUSD = false): PayAssetOption => ({
  key: `0x${n.toString(16).padStart(40, "0")}`,
  symbol,
  label,
  address: `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`,
  decimals,
  swapFeeBps,
  isArcoUSD,
})
const USDC = option("USDC", "tUSDC", 0xa1, 6, 0)
const USDT = option("USDT", "tUSDT", 0xa2, 6, 10)
const RLUSD = option("RLUSD", "tRLUSD", 0xa3, 18, 10)
const ARCO = option("ArcoUSD", "ArcoUSD", 0xa4, 18, 0, true)

function panelProps(over: Record<string, unknown> = {}) {
  return {
    product,
    price: 1,
    operation: "deposit" as const,
    amount: "1000",
    requestId: "1",
    paymentBalance: "100",
    productBalance: "0",
    allowance: "0",
    allowanceRequired: false,
    greenlistEnforced: false,
    activeVault: product.depositVaultAddress,
    phase: "ready" as const,
    pausedNotice: null,
    error: null,
    txHashes: [] as string[],
    pendingRedemptions: [],
    onOperationChange: () => undefined,
    onAmountChange: () => undefined,
    onRequestIdChange: () => undefined,
    onApprove: () => undefined,
    onSubmit: () => undefined,
    onRequestRedeem: () => undefined,
    onClaim: () => undefined,
    onConnect: () => undefined,
    onSwitchNetwork: () => undefined,
    ...over,
  }
}

type PanelProps = Parameters<typeof GiwaInvestPanel>[0]
const render = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(<GiwaInvestPanel {...(panelProps(over) as unknown as PanelProps)} />)
const PAY_ASSETS = [USDC, USDT, RLUSD, ARCO]
const routed = (over: Record<string, unknown> = {}) =>
  render({
    routed: true,
    payAssets: PAY_ASSETS,
    payAsset: USDT,
    payBalance: "5000",
    payChoices: fundPayChoices(PAY_ASSETS, () => null),
    onPayAssetChange: () => undefined,
    ...over,
  })
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

test("without Router props the panel renders exactly as before", () => {
  assert.equal(render({ routed: false, payAssets: [], payAsset: null }), render())
  assert.doesNotMatch(render(), /Swap fee|Pay with/)
})

test("a Router fund shows the pay-asset chip, its balance and the fee-adjusted quote; no swap fee row or fee notes", () => {
  const html = routed()
  assert.match(html, /aria-label="Pay with: USDT"/)
  assert.match(html, /aria-haspopup="dialog"/) // the chip opens the token picker
  assert.doesNotMatch(html, /role="dialog"/) // closed: no picker in the page
  assert.match(text(html), /Balance: 5000/) // the selected USDT balance, not the fund's USDC balance
  // The fee is in the Transaction Fees breakdown (collapsed here), not a row of its own or a note on the chip.
  assert.doesNotMatch(text(html), /Swap fee|swap fee|No fee|0\.1% fee/)
  // 1,000 USDT − 0.1% = 999 USDC worth at NAV 1.0.
  assert.match(html, /value="999"/)
  assert.doesNotMatch(text(html), /Insufficient Balance/)

  const usdc = routed({ payAsset: USDC })
  assert.match(usdc, /aria-label="Pay with: USDC"/)
  assert.match(usdc, /value="1000"/)
  // The chip shows the coin's mark as the picker does.
  assert.match(html, /src="\/logos\/usdt\.png"/)
  assert.match(routed({ payAsset: ARCO }), /src="\/logos\/arcousd\.png"/)

  // Without the picker's rows the chip is the plain token label.
  assert.doesNotMatch(routed({ payChoices: [] }), /Pay with/)

  // Over the selected asset's balance: the button says so (in that asset's decimals).
  assert.match(text(routed({ payBalance: "10" })), /Insufficient Balance/)
})

test("the redeem side ignores the Router pay asset (it always pays the fund's asset)", () => {
  const html = routed({ operation: "redeemInstant", amount: "1", productBalance: "10" })
  assert.doesNotMatch(html, /Pay with|Swap fee/)
  assert.match(text(html), /USDC/)
})

test("a closed buy gate disables the buy and shows the reserve notice", () => {
  const html = routed({ pausedNotice: RESERVE_REFILL_NOTICE })
  assert.match(text(html), /Purchases are temporarily paused while the reserve refills\./)
  const at = html.lastIndexOf(">Invest<")
  const tag = html.slice(html.lastIndexOf("<button", at), at)
  assert.match(tag, /disabled=""/)
})

test("while a transaction runs the pay asset cannot change; a fund whose route is still loading cannot buy", () => {
  assert.match(routed({ phase: "submitting" }), /aria-label="Pay with: USDT" disabled=""/)
  const loading = render({ phase: "loading-registry" })
  assert.match(text(loading), /Loading…/)
  const at = loading.lastIndexOf(">Loading…<")
  assert.match(loading.slice(loading.lastIndexOf("<button", at), at), /disabled=""/)
})

test("the token picker's rows: the Router's coins on GIWA with their balances, every other coin coming soon", () => {
  const balances: Record<string, number | null> = { [USDC.key]: 120, [USDT.key]: 0, [RLUSD.key]: null, [ARCO.key]: 7.5 }
  const choices = fundPayChoices(PAY_ASSETS, (asset) => balances[asset.key] ?? null)
  const byKey = Object.fromEntries(choices.map((choice) => [choice.key, choice]))
  assert.deepEqual(
    choices.filter((choice) => choice.available).map((choice) => choice.key),
    ["usdc-giwa", "usdt-giwa", "rlusd-giwa", "arcousd-giwa"],
  )
  assert.deepEqual(
    choices.filter((choice) => !choice.available).map((choice) => choice.key),
    ["usdc-ethereum", "usdt-ethereum", "rlusd-ethereum", "rlusd-xrpl"],
  )
  assert.deepEqual([byKey["usdc-giwa"].balance, byKey["usdc-giwa"].usd], [120, 120])
  assert.equal(byKey["rlusd-giwa"].balance, null)
  assert.equal(byKey["arcousd-giwa"].balance, 7.5)
  assert.deepEqual([byKey["rlusd-xrpl"].balance, byKey["rlusd-xrpl"].usd], [null, null])

  // A row and its pay asset map both ways; a coming-soon row has none.
  assert.equal(payAssetOptionKey(USDT), "usdt-giwa")
  assert.equal(payAssetOptionKey(ARCO), "arcousd-giwa")
  assert.equal(payAssetForOption(PAY_ASSETS, "rlusd-giwa"), RLUSD)
  assert.equal(payAssetForOption(PAY_ASSETS, "usdt-ethereum"), null)
  assert.equal(payAssetLogo(RLUSD), "/logos/rlusd.png")
  // A Reserve coin the picker does not list stays out of it.
  assert.equal(payAssetOptionKey(option("DAI", "tDAI", 0xa5, 18, 10)), null)
  // Without the RLUSD route the RLUSD row on GIWA is coming soon too.
  assert.equal(fundPayChoices([USDC, USDT, ARCO], () => null).find((choice) => choice.key === "rlusd-giwa")?.available, false)
})

test("the swap fee's (?) names the coins that pay it, from the Reserve's fees, and says who charges it", () => {
  const whose = "This fee is charged by third-party stablecoin infrastructure."
  assert.equal(
    stablecoinSwapFeeTip(PAY_ASSETS),
    `Paying with USDT or RLUSD includes a 0.1% swap fee. USDC and ArcoUSD have no swap fee. ${whose}`,
  )
  assert.equal(
    stablecoinSwapFeeTip([USDC, USDT, { ...RLUSD, swapFeeBps: 25 }, ARCO]),
    `Paying with USDT (0.1%) or RLUSD (0.25%) includes a swap fee. USDC and ArcoUSD have no swap fee. ${whose}`,
  )
  assert.equal(stablecoinSwapFeeTip([USDT, RLUSD]), `Paying with USDT or RLUSD includes a 0.1% swap fee. ${whose}`)
  assert.equal(
    stablecoinSwapFeeTip([USDC, USDT, ARCO]),
    `Paying with USDT includes a 0.1% swap fee. USDC and ArcoUSD have no swap fee. ${whose}`,
  )
  assert.equal(
    stablecoinSwapFeeTip([USDC, { ...USDT, swapFeeBps: 0 }, ARCO]),
    "No stablecoin currently has a swap fee. A swap fee, when set, is charged by third-party stablecoin infrastructure.",
  )
})

test("the Transaction Fees row: the swap fee of the coin paid with (none for USDC and ArcoUSD), with the (?) text", () => {
  const help = stablecoinSwapFeeTip(PAY_ASSETS)
  assert.deepEqual(stablecoinSwapFee(USDT, PAY_ASSETS), { bps: 10, help })
  assert.deepEqual(stablecoinSwapFee(RLUSD, PAY_ASSETS), { bps: 10, help })
  assert.deepEqual(stablecoinSwapFee(USDC, PAY_ASSETS), { bps: 0, help })
  // ArcoUSD never pays it, whatever its row says.
  assert.deepEqual(stablecoinSwapFee({ ...ARCO, swapFeeBps: 10 }, PAY_ASSETS), { bps: 0, help })
})

test("the faucet button lists the Reserve's test stablecoins too, on the same faucet", () => {
  const faucet = "0x00000000000000000000000000000000000000f1" as `0x${string}`
  const base = [{ symbol: "tUSDC", name: "Test USDC", decimals: 6, address: "0x00000000000000000000000000000000000000A1" as `0x${string}`, faucet }]
  const merged = withReserveTestAssets(base, [
    { symbol: "tUSDC", address: "0x00000000000000000000000000000000000000a1", decimals: 6 },
    { symbol: "tUSDT", address: "0x00000000000000000000000000000000000000a2", decimals: 6 },
    { symbol: "tRLUSD", address: "0x00000000000000000000000000000000000000a3", decimals: 18 },
    { symbol: "bad", address: "nope", decimals: 6 },
  ])
  assert.deepEqual(merged.map((asset) => asset.symbol), ["tUSDC", "tUSDT", "tRLUSD"])
  assert.ok(merged.every((asset) => asset.faucet === faucet))
})

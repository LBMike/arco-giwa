import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RESERVE_REFILL_NOTICE, type PayAssetOption } from "./arcousd-buy"
import { GiwaInvestPanel, withReserveTestAssets } from "./components"
import { PayAssetSelect } from "./PayAssetSelect"
import type { GiwaCatalogItem } from "./types"

// ArcoRouter fund buys in the invest panel: the "You pay" dropdown, the swap fee row, the selected
// asset's balance, and the buy gate notice. Without Router props the panel is unchanged.

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
const routed = (over: Record<string, unknown> = {}) =>
  render({ routed: true, payAssets: [USDC, USDT, RLUSD, ARCO], payAsset: USDT, payBalance: "5000", onPayAssetChange: () => undefined, ...over })
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

test("without Router props the panel renders exactly as before", () => {
  assert.equal(render({ routed: false, payAssets: [], payAsset: null }), render())
  assert.doesNotMatch(render(), /Swap fee|Pay with/)
})

test("a Router fund shows the pay-asset dropdown, its balance, the swap fee and the fee-adjusted quote", () => {
  const html = routed()
  assert.match(html, /aria-label="Pay with: USDT"/)
  assert.match(html, /aria-haspopup="menu"/)
  assert.match(html, /aria-expanded="false"/)
  assert.match(text(html), /Balance: 5000/) // the selected USDT balance, not the fund's USDC balance
  assert.match(text(html), /Swap fee 0\.1%/)
  // 1,000 USDT − 0.1% = 999 USDC worth at NAV 1.0.
  assert.match(html, /value="999"/)
  assert.doesNotMatch(text(html), /Insufficient Balance/)

  const usdc = routed({ payAsset: USDC })
  assert.match(text(usdc), /Swap fee No fee/)
  assert.match(usdc, /value="1000"/)

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

test("PayAssetSelect renders a closed trigger; a single option still renders its label", () => {
  const html = renderToStaticMarkup(
    <PayAssetSelect options={[{ key: "a", label: "USDC", note: "No fee" }, { key: "b", label: "USDT", note: "0.1% fee" }]} selected="b" onSelect={() => undefined} />,
  )
  assert.match(html, /aria-label="Pay with: USDT"/)
  assert.doesNotMatch(html, /role="menu"/) // closed: no menu in the page
  const fallback = renderToStaticMarkup(<PayAssetSelect options={[{ key: "a", label: "USDC" }]} selected="zzz" onSelect={() => undefined} />)
  assert.match(fallback, /Pay with: USDC/)
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
